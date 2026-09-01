FROM node:18-bullseye

RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY backup.js ./
COPY auth.js ./
COPY license.js ./
COPY Cfg_backup.yml ./
COPY Cfg_admin.yml ./
COPY public ./public

ENV DB_PATH=/data/planning.db
ENV PORT=3000

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
