FROM node:22-alpine

WORKDIR /app

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/server.js ./backend/server.js
COPY frontend ./frontend

ENV HOST=0.0.0.0
ENV HTTP_PORT=3000
ENV WS_PORT=3001

EXPOSE 3000 3001

CMD ["node", "backend/server.js"]
