FROM node:20-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
RUN mkdir -p /data/customers
EXPOSE 3100
VOLUME ["/var/run/docker.sock", "/data"]
CMD ["node", "server.js"]
