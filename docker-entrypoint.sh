#!/bin/sh
chown -R node:node /usr/src/app/json-data /usr/src/app/grib-data
exec gosu node dumb-init "$@"
