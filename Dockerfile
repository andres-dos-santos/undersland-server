FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM dependencies AS development
ENV NODE_ENV=development
COPY . .
USER node
EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "watch", "src/server.ts"]

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
