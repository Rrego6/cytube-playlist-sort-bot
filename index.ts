import axios from "axios";
import util from 'util';
import {io, Socket} from "socket.io-client";

import config from './config.json';
export type Config = typeof config;

interface MoveVideoResponse {
    from: number;
    after: number;
}

interface QueueResponse {
    item : PlaylistItem,
    after: string | number
}

interface PlaylistItem {
    media: Media;
    uid: number;
    temp: boolean;
    queueby: string;
}

interface PlaylistResponse extends Array<PlaylistItem>{}

interface Media {
    id: string;
    title: string;
    seconds: number;
    duration: string;
    type: string;
    meta: any;
}


const RequestPlaylist =  "requestPlaylist";
const Login =  "login";
const InitChannelCallbacks =  "InitChannelCallbacks";

interface MoveVideoResponse{
    from: number,
    after: number
}
interface MoveMediaData{
    from: number,
    after: number
}

interface Context {
    Config : Config,
    Socket : Socket,
    VideoQueue : PlaylistResponse,
    botSessionId: string
    readyHandleMessages?: boolean // bot will ignore previous chat messages before it sees its initialization message (with botSessionId). Used to prevent bot from responding to old messages
    loginSuccess: boolean,
    moveVideoRefCounter : Map<string, true>
}

function logSocketEmit(event : string, data? : any) {
    console.log(`Socket Emit | ${event} : ${util.inspect(data)}`);
}

function logSocketRecieve(event : string, data : any) {
    console.log(`Socket Recieve | ${event} :  ${util.inspect(data)}`);
}

// Get the socket server from cytube server api
async function getSecureServer(config : Config) : Promise<string> {
    const apiUrl = `${config.serverBaseUrl}/socketconfig/${config.room}.json`;
    const serverJson = await axios.get(apiUrl)
    const serverList = serverJson.data as {servers :  {url : string, secure: boolean}[]};
    return serverList.servers.find(server => server.secure === true)!.url;
}

//check if config.cytubeServer is valid url 
function validateConfiguration(config : Config) {
    try{
        new URL(config.serverBaseUrl);
        if(config.username === "" || config.password === "") {
            throw new TypeError("Username or password is empty");
        } if (config.room === "") {
            throw new TypeError("Room is empty");
        }
    } catch (e : any ) {
        e.message = `Invalid config file: ${e.message}`;
        throw e;
    }
}

function onPlaylistCallback(context: Context, response: PlaylistResponse) {
    // wait until logged in to process playlist. For some reason, playlist is sent twice once before log in (in wrong order). and once after
    if(!context.loginSuccess) {
        return;
    }

    context.VideoQueue = response;
    if( !(context.VideoQueue && context.VideoQueue.length > 0)) {
        return;
    }
    context.moveVideoRefCounter = new Map();
    const sortedVideos = roundRobinSortVideos(context);
    sortCytube(context, sortedVideos)
}

function getInitString(context :Context) {
    return `Hi. Initialized bot: ${context.botSessionId}`;
}

//todo: check if sent by admin
function onChatMsgCallback(context: Context, response: { username: string, msg: string, meta: any, time: number }) {
    if(!context.readyHandleMessages) {
        if(response.msg === getInitString(context)) {
            context.readyHandleMessages = true;
        }
        return;
    }
    if (response.msg === `${config.username}: !sort`) {
        ForceSortVideoQueue(context);
    }
}

function onMoveVideoCallback(context : Context, response: MoveVideoResponse) {
    // skip if this is a move video response from this bot
    const stringified = JSON.stringify(response);
    const alreadyMoved = context.moveVideoRefCounter.get(stringified);
    if(alreadyMoved) {
        context.moveVideoRefCounter.delete(stringified);
        return;
    }
    const from = response.from;
    const after = response.after;
    const fromIndex = context.VideoQueue.findIndex(video => video.uid === from);
    const video = context.VideoQueue[fromIndex];
    context.VideoQueue.splice(fromIndex, 1);
    const afterIndex = context.VideoQueue.findIndex(video => video.uid === after);
    context.VideoQueue.splice(afterIndex+1, 0, video);


    // sort after move
    const sortedVideos = roundRobinSortVideos(context);
    sortCytube(context, sortedVideos)
}

function onDeleteCallback(context: Context , response: { uid: number }) {
    const deleteIndex = context.VideoQueue.findIndex(video => video.uid === response.uid);
    context.VideoQueue.splice(deleteIndex, 1);
    const sortedVideos = roundRobinSortVideos(context);
    sortCytube(context, sortedVideos)
}

function onErrorMsg(context : Context, response : { msg: string } ) {
    const criticalErrors = [
        "Invalid channel name",
        "blocked anonymous users",
        "Unable to join channel",
        "Channel could not be loaded",
        "Invalid login"
    ]
    const isCritialerror =  criticalErrors.some(error => response.msg.toLowerCase().includes(error.toLowerCase()));
    if (isCritialerror) {
        throw new Error(response.msg);
    }
    console.error(response.msg);
}

function onQueueCallback(context: Context, response : QueueResponse) {
    if (response.after as string === "prepend") {
        context.VideoQueue.unshift(response.item);
    } else {
        const index = context.VideoQueue.findIndex(video => video.uid === response.after);
        context.VideoQueue.splice(index + 1, 0, response.item);
    }    
    const sortedVideos = roundRobinSortVideos(context);
    sortCytube(context, sortedVideos)
}

// adds logging and context logging to socket on
function socketOnWithLoggingAndContext<T>(context : Context, event : string, callback : (context : Context, response :T) => void) {
    const callbackWithLogging = (response : T) => {
//        logSocketRecieve(event, response);
        callback(context, response);
    }
    Object.defineProperty(callbackWithLogging, 'name', {value : callback.name, writable: false});
    console.log(`socket.on handler {${callback.name}} added for event {${event}}`);
    context.Socket.on(event, callbackWithLogging);
}

//add logging and context to socket emit
function socketEmitWithLoggingAndContext<T extends Object>(context : Context, event : string, data? : T) {
    logSocketEmit(event, data);
    return context.Socket.emit(event, data);
}

// proxies emit call so that it is applied with context
function getEmitProxy(context : Context): <T extends Object>(event : string, data? : T) => void {
    return <T extends Object>(event : string, data? : T) => {
        return socketEmitWithLoggingAndContext(context, event, data);
    }
}

// proxies on call so that it is applied with context
function getOnProxy(context : Context): <T>(event : string, callback : (context : Context, response : T) => void) => void {
    return <T>(event : string, callback : (context : Context, response : T) => void) => {
        socketOnWithLoggingAndContext(context, event, callback);
    }
}

// TODO: handle much better. Definitely need to check permissions here
// Seems like best place for sending messages and validating login.
function onSetPermissionsCallback(context : Context, response : any) {
    const emitProxy = getEmitProxy(context);
}

// todo handle
//handle
function onRankCallback(context : Context, response : any) {
}

//determine if login was successful
function onLoginCallback(context : Context, response : {success : boolean, name : string}) {
    if(response.success) {
        context.loginSuccess = true;
        const emitProxy = getEmitProxy(context);
        emitProxy("chatMsg", { msg: getInitString(context) });
    } else {
        throw new Error().message = `Login failed: ${util.inspect(response.name)} `;
    }
}

function onDisconnectCallback(context : Context, response : any) {
    console.log("Disconnected from server");
    process.exit(1);
}


async function main() {
    validateConfiguration(config);
    const serverUrl = await getSecureServer(config);
    const socket = io(serverUrl);
    
    const botSeshId = Math.random().toString();
    const context : Context = {
        Config: config,
        VideoQueue: [],
        Socket: socket,
        botSessionId: botSeshId,
        loginSuccess: false,
        moveVideoRefCounter: new Map<string, true>(),
    }
    const emitProxy = getEmitProxy(context);
    const onProxy = getOnProxy(context);

    //for debugging, just log any received socket
    socket.onAny((event, ...args) => {
        logSocketRecieve(event, args);
    });


    onProxy("login", onLoginCallback);
    onProxy("playlist", onPlaylistCallback);
    onProxy("setPermissions", onSetPermissionsCallback);
    onProxy("rank", onRankCallback);

    //handle chat messages seen by bot. Good place for chat commands
    onProxy("chatMsg", onChatMsgCallback);

    //handle moving video
    onProxy("moveVideo", onMoveVideoCallback);

    //handle deleting video. Sort queue
    onProxy("delete", onDeleteCallback);

    //handle adding to queue. sort queue
    onProxy("queue", onQueueCallback);

    onProxy("disconnect", onDisconnectCallback);

    emitProxy(InitChannelCallbacks);
    emitProxy("joinChannel", { name: context.Config.room });
    onProxy("errorMsg", onErrorMsg);

    emitProxy("login", { name: context.Config.username, pw: context.Config.password});
}



// should perform the minimal amount of move commands to alter queue to sorted queue
// maybe this is edit distance?
function sortCytube(context: Context, sortedPlaylistOriginal: PlaylistItem[] ) {

    const emitProxy = getEmitProxy(context);

    //copy so it is not overwritten while moving videos
    const sortedPlaylist = [...sortedPlaylistOriginal];
    const toSortPlaylist = [...context.VideoQueue];

    let prevSortedUid  = -1;
    for(let i = 0; i < sortedPlaylist.length; i++) {
        const sortedUid = sortedPlaylist[i].uid;
        const toSortUid = toSortPlaylist[i].uid;
        if( prevSortedUid != -1 && sortedUid != toSortUid) {
            const data = { from: sortedUid, after: prevSortedUid };
            context.moveVideoRefCounter.set( JSON.stringify(data), true );
            emitProxy("moveMedia", data);
            
            const videoIndexToMove = toSortPlaylist.findIndex(video => video.uid === sortedUid);
            const videoToMove = toSortPlaylist.splice(videoIndexToMove, 1)[0];
            toSortPlaylist.splice(i, 0, videoToMove);
        }
        prevSortedUid = sortedUid;
    }

    context.VideoQueue = [...sortedPlaylistOriginal];
}


function ForceSortVideoQueue(context: Context) {
    const emitProxy = getEmitProxy(context);
    // will triger OnPlaylistCallback which will sort the queue
    emitProxy(RequestPlaylist);
}

// should sort videos in a round robin fashion
// need to fix implementation
function roundRobinSortVideos(context: Context) : PlaylistItem[] {
    const userToVideoListMap : Map<string, PlaylistItem[]> = new Map();
    context.VideoQueue.forEach(video => userToVideoListMap.set(video.queueby, []));
    context.VideoQueue.forEach(video => userToVideoListMap.get(video.queueby)!.push(video));

    const maxVideos = Math.max(...[...userToVideoListMap.values()].map(v => v.length));
    const userNames = [...userToVideoListMap.keys()]; //required since iterators cant be loopd multiple times??
    const sorted : PlaylistItem[] = [];

    for (let _ = 0; _ < maxVideos; _++) {
        for(const userName of userNames) {
            const videos = userToVideoListMap.get(userName) as PlaylistItem[];
            if (videos.length > 0) {
                sorted.push(videos.shift() as PlaylistItem);
            }
        }
    }
    return sorted;
}

main();

