FROM node:20.17-alpine3.20 AS build
WORKDIR /app
COPY package*.json ./
RUN npm install -g pnpm
RUN pnpm install
RUN pnpm lint
RUN pnpm clean

COPY . .
RUN pnpm build
RUN ls -l /app/dist

FROM node:20.17-alpine3.20
WORKDIR /app
COPY --from=build /app/dist .
RUN ls /app

EXPOSE 3000
CMD [ "node", "/app/index.js" ]
