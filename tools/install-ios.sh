#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

read_setting() {
  local value
  if ! value=$(git config --local --get "$1") || [[ -z "$value" ]]; then
    printf '缺少本机设置 %s，请按 ios/README.md 配置。\n' "$1" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

device=$(read_setting along.iosDevice)
team=$(read_setting along.iosTeam)
bundle_id=$(read_setting along.iosBundleId)
build_dir="$PWD/ios/build/install"
app="$build_dir/Build/Products/Release-iphoneos/AlongHealth.app"

npm run build
xcodebuild -project ios/AlongHealth.xcodeproj -scheme AlongHealth \
  -configuration Release -destination "platform=iOS,id=$device" \
  -derivedDataPath "$build_dir" -allowProvisioningUpdates \
  "DEVELOPMENT_TEAM=$team" "PRODUCT_BUNDLE_IDENTIFIER=$bundle_id" build

app_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")
app_build=$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$app/Info.plist")
if [[ "$app_id" != "$bundle_id" || -z "$app_build" ]]; then
  printf '构建产物的 Bundle ID 或 Build 号无效。\n' >&2
  exit 1
fi

xcrun devicectl device install app --timeout 90 --device "$device" "$app"
installed_build=$(
  xcrun devicectl device info apps --timeout 20 --device "$device" \
    --bundle-id "$bundle_id" --json-output - |
    node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.apps[0]?.bundleVersion ?? ""'
)

if [[ "$installed_build" != "$app_build" ]]; then
  printf '设备回读的 Build 号为 %s，预期为 %s。\n' "${installed_build:-未找到}" "$app_build" >&2
  exit 1
fi
printf 'Along Build %s 安装成功，设备回读确认。\n' "$app_build"
