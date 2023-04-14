FROM node:alpine

RUN mkdir /app
WORKDIR /app

COPY . .

RUN npm install
LABEL fly_launch_runtime="nodejs"

CMD [ "npm", "run", "start" ]
