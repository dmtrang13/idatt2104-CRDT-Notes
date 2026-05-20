FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY editor.html server.js ./

ENV HOST=0.0.0.0
ENV HTTP_PORT=3000
ENV WS_PORT=3001

EXPOSE 3000 3001

CMD ["node", "server.js"]
