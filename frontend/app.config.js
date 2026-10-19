// The Expo config is app.json. This adds the one thing only some checkouts
// have.
//
// google-services.json is Firebase's config for the Android app, which match
// alerts need. It is kept out of this repository, which is public, and reaches
// EAS in the upload (see the root .easignore). Naming it in app.json would make
// every checkout without it fail to prebuild; named here only when it is
// present, such a checkout builds an Android app that says alerts are
// unavailable instead.
const fs = require('node:fs');
const path = require('node:path');

module.exports = ({ config }) => {
  if (!fs.existsSync(path.join(__dirname, 'google-services.json'))) return config;
  return {
    ...config,
    android: { ...config.android, googleServicesFile: './google-services.json' },
  };
};
