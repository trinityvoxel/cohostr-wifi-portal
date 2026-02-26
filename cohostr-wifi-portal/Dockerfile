ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY src/package.json ./
RUN npm install
COPY src/ ./
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
