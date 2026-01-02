## Project Principles
- Experimenting with aggressive simplicity while remaining in the realm of correctedness
    - This means I'm not going to implement glacial models but simple, powerful levers to simulate ice ages

## Processing Tiles
Downloaded dataset from: https://download.gebco.net/
Click other downloads top right > GEBCO 2024 Grid With sub-ice topography/bathymetry information > Single netCDF 

Then I processed into tiles on WSL like this:

```bash
gdal_translate -of GTiff \
  -co TILED=YES -co COMPRESS=DEFLATE -co PREDICTOR=2 -co BIGTIFF=YES \
  GEBCO_2024_sub_ice_topo.nc gebco4326.tif

gdalwarp \
  -t_srs EPSG:3857 \
  -r bilinear \
  -dstnodata -32768 \
  -co TILED=YES -co COMPRESS=DEFLATE -co PREDICTOR=2 -co BIGTIFF=YES \
  gebco4326.tif gebco3857.tif

gdaladdo -r average gebco3857.tif 2 4 8 16 32 64

gdal_translate -of VRT -ot Byte \
  -a_nodata 255 \
  -scale -10919 8627 0 254 \
  gebco3857.tif gebco3857_byte.vrt

gdal2tiles.py -z 0-0 --tilesize=512 -w none \
  gebco3857_byte.vrt tiles/
```


## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

