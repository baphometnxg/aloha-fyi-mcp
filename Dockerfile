FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY *.ts ./
# AAAK adapter modules — lib/aaak.ts and lib/aaak-adapter.ts are imported
# by http.ts. tests/ and scripts/ are dev-only and intentionally omitted
# from the image; the tsconfig include patterns warn-but-don't-fail when
# those directories are missing in the Docker context.
COPY lib ./lib
RUN npx tsc

EXPOSE 9624

ENV PORT=9624

CMD ["node", "dist/http.js"]
