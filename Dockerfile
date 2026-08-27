# Use the official Bun image as the base
FROM oven/bun:latest

WORKDIR /app

# Copy all files into the image
COPY . .

# Install dependencies
RUN bun install

# Ensure entrypoint.sh is executable
RUN chmod +x /app/entrypoint.sh

# The internal GitLab host presents a certificate signed by the corporate CA,
# which the base image does not ship. Without this, requests to it fail with
# UNABLE_TO_VERIFY_LEAF_SIGNATURE.
ENV NODE_EXTRA_CA_CERTS=/app/certs/corporate-ca.pem

# Default command (can be overridden by docker-compose)
CMD ["bun", "start"]
