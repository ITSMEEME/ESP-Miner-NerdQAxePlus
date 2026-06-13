#!/bin/bash
set -e
export VERSION_TAG="v1.0.36"
export BOARD="NERDAXEGAMMA"
export COMMIT_HASH=$(git rev-parse --short HEAD)

echo "Backing up files..."
cp ./main/http_server/axe-os/src/app/app.module.ts ./app.module.ts.bak
for l in de en es fr; do
  cp "./main/http_server/axe-os/src/assets/i18n/${l}.json" "./main/http_server/axe-os/src/assets/i18n/${l}.${COMMIT_HASH}.json"
done

echo "Inserting Version..."
sed -e "s|__COMMIT__|${COMMIT_HASH}|g" -i ./main/http_server/axe-os/src/app/app.module.ts
sed -e "s|__VERSION__|${VERSION_TAG}|g" -i ./main/http_server/axe-os/src/app/app.module.ts

echo "Setting Target..."
docker run --rm --user root -e BOARD=${BOARD} -v $PWD:/home/builder/project shufps/esp-idf-builder:0.0.1 idf.py set-target esp32s3

echo "Building..."
docker run --rm --user root -e BOARD=${BOARD} -v $PWD:/home/builder/project shufps/esp-idf-builder:0.0.1 idf.py build

echo "Merging Binaries..."
docker run --rm --user root -v $PWD:/home/builder/project shufps/esp-idf-builder:0.0.1 esptool.py --chip esp32s3 merge_bin --flash_mode dio --flash_size 16MB --flash_freq 80m 0x0 build/bootloader/bootloader.bin 0x8000 build/partition_table/partition-table.bin 0x10000 build/esp-miner.bin 0x410000 build/www.bin 0xf10000 build/ota_data_initial.bin -o esp-miner-factory-NerdAxeGamma-v1.0.36.bin

echo "Cleaning up..."
mv ./app.module.ts.bak ./main/http_server/axe-os/src/app/app.module.ts
for l in de en es fr; do
  rm "./main/http_server/axe-os/src/assets/i18n/${l}.${COMMIT_HASH}.json"
done

echo "Done!"
