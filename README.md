# wind-js-server [![NPM version][npm-image]][npm-url] [![NPM Downloads][npm-downloads-image]][npm-url]

Simple demo rest service to expose [GRIB2](http://en.wikipedia.org/wiki/GRIB) wind forecast data 
(1 degree, 6 hourly from [NOAA](http://nomads.ncep.noaa.gov/)) as JSON. <br/>

Consumed in [leaflet-velocity](https://github.com/danwild/leaflet-velocity).
Contains a pre-packaged copy of [grib2json](https://github.com/cambecc/grib2json) for conversion.

Data Vis demo here: http://danwild.github.io/leaflet-velocity

Note that this is intended as a crude demonstration, not intended for production use.
To get to production; you should improve upon this or build your own.

## Running with Docker Compose (recommended)

Requires [Docker](https://docs.docker.com/get-docker/) with Compose plugin.

```bash
# copy and edit config (CORS whitelist, retention, etc.)
cp .env.example .env

# build and start
docker compose up -d

# view logs
docker compose logs -f

# stop
docker compose down
```

The `json-data/` folder is mounted as a host volume — wind data persists across container restarts and rebuilds. Files older than `RETENTION_DAYS` (default: 30) are removed automatically on startup and once per day.

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | Server port |
| `CORS_WHITELIST` | localhost origins | Comma-separated allowed origins |
| `RETENTION_DAYS` | `30` | Days of JSON data to keep |
| `NOAA_BASE_URL` | NOMADS GFS filter URL | Override NOAA data source |
| `HARVEST_DEPTH_DAYS` | `7` | Days back to search for data |
| `REQUEST_DELAY_MS` | `2000` | Delay between NOAA requests (ms) |

## install, run (without Docker):

Requires Node.js, npm, and Java JRE (for grib2json conversion).

```bash
# from project root:
cp .env.example .env
npm install
npm start
```

## endpoints
- **/latest** returns the most up to date JSON data available
- **/nearest** returns JSON data nearest to requested
	- $GET params:
		- `timeIso` an ISO timestamp for temporal target
		- `searchLimit` number of days to search beyond the timeIso (will search backwards, then forwards)
- **/alive** health check url, returns simple message

## License
MIT License (MIT)

[npm-image]: https://badge.fury.io/js/wind-js-server.svg
[npm-url]: https://www.npmjs.com/package/wind-js-server
[npm-downloads-image]: https://img.shields.io/npm/dt/wind-js-server.svg