FROM node:24-alpine

WORKDIR /data/app

RUN \
    apk add --no-cache ghostscript \
    apk add --no-cache libreoffice libheif libde265 \
    apk add --no-cache ttf-dejavu ttf-freefont \
    apk add --no-cache font-noto-cjk \
    npm ci --omite=dev

# Відкриваємо порт (Fly визначає його через $PORT)
EXPOSE 3000

# Запуск бота через Node
CMD ["node", "dist/index.js"]
