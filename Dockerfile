FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY *.ts ./
RUN npx tsc

EXPOSE 9624

ENV PORT=9624

CMD ["node", "dist/http.js"]
