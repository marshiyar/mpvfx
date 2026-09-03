const { join } = require("node:path");

module.exports = {
  cacheDirectory: join(__dirname, ".puppeteer-cache"),
  chrome: {
    skipDownload: true,
  },
  "chrome-headless-shell": {
    skipDownload: false,
  },
};
