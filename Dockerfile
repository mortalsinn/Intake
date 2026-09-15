# ========================================================
# Filename: Dockerfile
# Description: The intake kiosk as a single container, for
# handing to somebody to try.
#
# Defaults to DEMO MODE: no Zoho credentials are baked in and
# the build refuses to connect to a CRM at all. A tester gets
# the real pipeline — device queue, disk, dedupe, CSV — with
# nothing able to reach live customer data.
#
#   docker build -t intake .
#   docker run -p 3100:3100 intake
#
# Then open http://localhost:3100 (admin: /admin.html, PIN 162534).
# ========================================================
FROM node:22-alpine

# Only two dependencies and no native modules, so there is nothing to
# compile and no build stage to split out.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY config ./config
COPY public ./public
COPY scripts ./scripts

# Captured leads live here. Declared a volume so a `docker run` without -v
# still survives a container restart, and a tester can mount a host folder to
# keep what they captured.
ENV DATA_DIR=/data
VOLUME /data

ENV NODE_ENV=production
ENV PORT=3100
# Both default ON for a handout build. Override DEMO_MODE only for a real
# booth, and set your own ADMIN_PIN when you do — this one is published in
# the repository.
ENV DEMO_MODE=1
ENV ADMIN_PIN=162534

# node:alpine ships an unprivileged `node` user. The data directory has to be
# created and chowned here, because a VOLUME declared above is otherwise root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3100

# /api/form is the same path Render health-checks: it reads and parses the
# form spec, so a broken config fails the check rather than serving a kiosk
# that cannot render a form.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/form').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
