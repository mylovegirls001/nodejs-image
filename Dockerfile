FROM node:20-alpine3.20

WORKDIR /tmp

COPY index.js index.html package.json ./

# EXPOSE 只是声明端口元信息，不真正映射。实际映射靠 docker run -p。
EXPOSE 9527

RUN apk update && apk add --no-cache bash openssl curl &&\
    chmod +x index.js &&\
    npm install

CMD ["node", "index.js"]
