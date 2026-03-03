FROM node:20-alpine

# Create app directory
WORKDIR /app

# git is required for npm to install GitHub-sourced packages
RUN apk add --no-cache git

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY extension.js ./

# Expose REST API port
EXPOSE 3001

# Roon SOOD discovery uses UDP 9003 (handled via host networking)
# No need to expose — just use --network host or macvlan

ENV NODE_ENV=production

CMD ["node", "extension.js"]
