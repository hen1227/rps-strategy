// Firebase Messaging starts with the app and fetches a push token at once,
// whether or not anybody has turned match alerts on. That token is a device
// identifier sent to Google, and the store listing says what is true without
// this: alerts are optional, and a device is registered only when its owner
// asks for them.
//
// Turning the automatic start off leaves the one fetch the app makes itself,
// `getDevicePushTokenAsync` when alerts are turned on (see `store/pushNative.ts`),
// which works the same either way.
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

module.exports = (config) =>
  withAndroidManifest(config, (manifest) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      'firebase_messaging_auto_init_enabled',
      'false',
    );
    return manifest;
  });
