FROM node:20-alpine

# Встановлюємо системні залежності (Ghostscript та LibreOffice для конвертації)
RUN apk add --no-cache \
    ghostscript \
    libreoffice \
    libheif \
    libde265 \
    ttf-dejavu \
    ttf-freefont \
    font-noto-cjk

# Робоча директорія всередині контейнера
WORKDIR /app

# Копіюємо package.json та package-lock.json для встановлення залежностей
COPY package*.json ./

# Встановлюємо залежності
RUN npm install --production

# Копіюємо весь проєкт
COPY . .

# Відкриваємо порт (Fly визначає його через $PORT)
ENV PORT=8080

# Запуск бота через Node
CMD ["node", "index.js"]
