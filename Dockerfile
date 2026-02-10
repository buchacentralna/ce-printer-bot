FROM node:24-alpine

WORKDIR /data/app
ADD . /data/app

RUN apk add --no-cache ghostscript libreoffice libheif libde265 \
    ttf-dejavu ttf-freefont font-noto-cjk && \
    npm ci --omit=dev

# Відкриваємо порт (Fly визначає його через $PORT)
EXPOSE 3000

# Запуск бота через Node
CMD ["node", "dist/index.js"]
