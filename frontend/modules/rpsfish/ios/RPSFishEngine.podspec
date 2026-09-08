# Copyright (C) 2026 Henry Abrahamsen
# SPDX-License-Identifier: LGPL-3.0-or-later

require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'RPSFishEngine'
  s.version        = package['version']
  s.summary        = 'The RPSFish search engine, as a native iOS module.'
  s.description    = 'Bridges the RPSFish C ABI to JavaScript for RPS Strategy.'
  s.author         = 'Henry Abrahamsen'
  s.homepage       = 'https://rps.henhen1227.com'
  s.license        = { :type => 'LGPL-3.0-or-later' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Built by `RPSFish/scripts/build_ios.sh`, which copies it here. It is a
  # build artifact rather than source, so it is not in the repository: a clean
  # checkout has to run `npm run build:rpsfish:ios` before `pod install`.
  s.vendored_frameworks = 'RPSFish.xcframework'

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
  s.exclude_files = 'RPSFish.xcframework/**/*'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
