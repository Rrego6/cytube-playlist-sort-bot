import axios from "axios";
import config from './config.json';
import {io, Socket} from "socket.io-client";

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


interface Context {
    Config : Config,
    Socket : Socket,
    VideoQueue : PlaylistResponse,
    UidToVideoIndexMap : Map<number, number>,
}

function emitPromise<T>(socket: Socket, event : string, ...args: any) : Promise<T> {
    return new Promise((resolve, reject) => {
        socket.emit(event, args, (data : T) => {
            resolve(data);
        });
    });
}

function onPromise<T>(socket: Socket, event : string, ...args: any) : Promise<T> {
    return new Promise((resolve, reject) => {
        socket.on(event, (data : T) => {
            resolve(data);
        });
    });
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
    console.log(`onPlayListCallback: ${response}`);
    context.VideoQueue = response;
    context.UidToVideoIndexMap = new Map(context.VideoQueue.map((video, index) => [video.uid, index]))
    if( !(context.VideoQueue && context.VideoQueue.length > 0)) {
        return;
    }
    const sortedVideos = roundRobinSortVideos(context);
    sortCytube(context, sortedVideos)
}

function onChatMsgCallback(context: Context, response: { username: string, msg: string, meta: any, time: number }) {
    console.log(`onChatMsgCallback: ${response}`);
    if (response.msg === `${config.username}: !sort`) {
        ForceSortVideoQueue(context);
    }
}

function onMoveVideoCallback(context : Context, response: MoveVideoResponse) {
    console.log(`onMoveVideoCallback: ${response}`);
    const from = response.from;
    const after = response.after;
    const fromIndex = context.UidToVideoIndexMap.get(from) as number;
    const afterIndex = context.UidToVideoIndexMap.get(after) as number;
    const video = context.VideoQueue[fromIndex];
    context.VideoQueue.splice(fromIndex, 1);
    context.VideoQueue.splice(afterIndex, 0, video);
    context.UidToVideoIndexMap = new Map(context.VideoQueue.map((video, index) => [video.uid, index]))
}

function onDeleteCallback(context: Context , response: { uid: number }) {
    console.log(`onDeleteCallback: ${response}`);
    const uid = response.uid;
    const deleteIndex = context.UidToVideoIndexMap.get(uid) as number;
    const video = context.VideoQueue[deleteIndex];
    context.VideoQueue.splice(deleteIndex, 1);
    context.UidToVideoIndexMap = new Map(context.VideoQueue.map((video, index) => [video.uid, index]))

    const sortedVideos = roundRobinSortVideos(context);
    sortCytube(context, sortedVideos)
}

function onErrorMsg( response : { msg: string } ) {
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

// partially applies context variable to callback?
function withContext<T>(context : Context, callback : (context : Context, response : T) => void ) {
    return (response : T) => callback(context, response);
}

function onQueueCallback(context: Context, response : QueueResponse) {
    if (response.after as string === "prepend") {
        context.VideoQueue.unshift(response.item);
    } else {
        const index = context.UidToVideoIndexMap.get(response.after as number) as number;
        context.VideoQueue.splice(index + 1, 0, response.item);
    }    
    context.UidToVideoIndexMap = new Map(context.VideoQueue.map((video, index) => [video.uid, index]))

    const sortedVideos = roundRobinSortVideos(context);
    sortCytube(context, sortedVideos)
}

async function main() {
    validateConfiguration(config);
    const serverUrl = await getSecureServer(config);
    const socket = io(serverUrl);
    const context : Context = {
        Config: config,
        VideoQueue: [],
        UidToVideoIndexMap: new Map(),
        Socket: socket,
    }

    // handle recieving entire playlist. We will also sort the list here.
    socket.on("playlist",  onPlaylistCallback.bind(undefined, context))
    socket.on("chatMsg", onChatMsgCallback.bind(undefined, context))
    socket.on("moveVideo", onMoveVideoCallback.bind(undefined, context));
    socket.on("delete", onDeleteCallback.bind(undefined, context));

    socket.on("queue", onQueueCallback.bind(undefined, context));

    socket.emit(InitChannelCallbacks);
    socket.emit("joinChannel", { name: context.Config.room });

    socket.once("errorMsg", onErrorMsg);

    // TODO: DETECT WHEN LOGIN IS INVALID. cytube does not seem to send an error msg
    socket.emit("login", { name: context.Config.username, pw: context.Config.password});
}



function sortCytube(context: Context, sortedPlaylistOriginal: PlaylistItem[] ) {
    //copy so it is not overwritten while moving videos
    const sortedPlaylist = [...sortedPlaylistOriginal];
    let current = sortedPlaylist.shift() as PlaylistItem;
    for (const video of sortedPlaylist) {
        if (video.uid !== current.uid) {
            context.Socket.emit("moveMedia", { uid: video.uid, after: current.uid});
        }
        current = video;
    }
}


function ForceSortVideoQueue(context: Context) {
    // will triger OnPlaylistCallback which will sort the queue
    context.Socket.emit(RequestPlaylist);
}

// should sort videos in a round robin fashion
// need to fix implementation
function roundRobinSortVideos(context: Context) : PlaylistItem[] {
    const userToVideoListMap : Map<string, PlaylistItem[]> = new Map();
    context.VideoQueue.forEach(video => userToVideoListMap.set(video.queueby, []));
    context.VideoQueue.forEach(video => userToVideoListMap.get(video.queueby)!.push(video));

    // get max number of videos in any user's queue.
    // TODO: FIX BROKEN IMPLEMENTATION
    const maxVideos = Math.max(...[...userToVideoListMap.values()].map(v => v.length));
    const userNames = userToVideoListMap.keys(); 
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

