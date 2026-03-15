FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  libreoffice-core \
  libreoffice-writer \
  libreoffice-common \
  libreoffice-java-common \
  default-jre-headless \
  fonts-crosextra-carlito \
  fonts-crosextra-caladea \
  fonts-liberation2 \
  fonts-dejavu-core \
  fonts-liberation \
  fonts-noto-core \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
