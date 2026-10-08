# The photo bot as a container, so it can be switched on and off from Docker
# Desktop (compose.yaml). The image is only the runtime: Node plus the OCR reader.
# Windows OCR doesn't exist in a Linux container, so Tesseract stands in, with
# ImageMagick for the resize + adaptive threshold it needs (ocr.mjs tesseractOcr).
# The code and config are mounted from the repo, so a git pull + restart is enough
# to run new code; rebuild only when this file changes.
FROM node:24-alpine
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng imagemagick
WORKDIR /app
CMD ["node", "tools/wo-bot/bot.mjs"]
