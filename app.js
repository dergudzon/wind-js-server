require("dotenv").config();

var express = require("express");
var moment = require("moment");
var http = require("http");
var request = require("request");
var fs = require("fs");
var Q = require("q");
var cors = require("cors");

var app = express();
var port = process.env.PORT || 7000;
var baseDir =
  process.env.NOAA_BASE_URL ||
  "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl";
var harvestDepthDays = parseInt(process.env.HARVEST_DEPTH_DAYS, 10) || 7;
var requestDelayMs = parseInt(process.env.REQUEST_DELAY_MS, 10) || 2000;
var requestUserAgent =
  process.env.REQUEST_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var retentionDays = parseInt(process.env.RETENTION_DAYS, 10) || 30;

// cors config - read whitelist from env (comma-separated) or use defaults
var defaultWhitelist = [
  "http://localhost:63342",
  "http://localhost:3000",
  "http://localhost:4000",
];

var whitelist = process.env.CORS_WHITELIST
  ? process.env.CORS_WHITELIST.split(",").map(function (origin) {
      return origin.trim();
    })
  : defaultWhitelist;

var corsOptions = {
  origin: function (origin, callback) {
    var originIsWhitelisted = whitelist.indexOf(origin) !== -1;
    callback(null, originIsWhitelisted);
  },
};

app.listen(port, function (err) {
  console.log("running server on port " + port);
});

app.get("/", cors(corsOptions), function (req, res) {
  res.send("hello wind-js-server.. go to /latest for wind data..");
});

app.get("/alive", cors(corsOptions), function (req, res) {
  res.send("wind-js-server is alive");
});

app.get("/latest", cors(corsOptions), function (req, res) {
  /**
   * Find and return the latest available 6 hourly pre-parsed JSON data
   *
   * @param targetMoment {Object} UTC moment
   */
  function sendLatest(targetMoment) {
    var stamp =
      moment(targetMoment).format("YYYYMMDD") +
      roundHours(moment(targetMoment).hour(), 6);
    var fileName = __dirname + "/json-data/" + stamp + ".json";

    res.setHeader("Content-Type", "application/json");
    res.sendFile(fileName, {}, function (err) {
      if (err) {
        if (res.headersSent) return;
        console.log(stamp + " doesnt exist yet, trying previous interval..");
        sendLatest(moment(targetMoment).subtract(6, "hours"));
      }
    });
  }

  sendLatest(moment().utc());
});

app.get("/nearest", cors(corsOptions), function (req, res, next) {
  var time = req.query.timeIso;
  var limit = req.query.searchLimit;
  var searchForwards = false;

  /**
   * Find and return the nearest available 6 hourly pre-parsed JSON data
   * If limit provided, searches backwards to limit, then forwards to limit before failing.
   *
   * @param targetMoment {Object} UTC moment
   */
  function sendNearestTo(targetMoment) {
    if (
      limit &&
      Math.abs(moment.utc(time).diff(targetMoment, "days")) >= limit
    ) {
      if (!searchForwards) {
        searchForwards = true;
        sendNearestTo(moment(targetMoment).add(limit, "days"));
        return;
      } else {
        return next(new Error("No data within searchLimit"));
      }
    }

    var stamp =
      moment(targetMoment).format("YYYYMMDD") +
      roundHours(moment(targetMoment).hour(), 6);
    var fileName = __dirname + "/json-data/" + stamp + ".json";

    res.setHeader("Content-Type", "application/json");
    res.sendFile(fileName, {}, function (err) {
      if (err) {
        if (res.headersSent) return;
        var nextTarget = searchForwards
          ? moment(targetMoment).add(6, "hours")
          : moment(targetMoment).subtract(6, "hours");
        sendNearestTo(nextTarget);
      }
    });
  }

  if (time && moment(time).isValid()) {
    sendNearestTo(moment.utc(time));
  } else {
    return next(
      new Error("Invalid params, expecting: timeIso=ISO_TIME_STRING"),
    );
  }
});

/**
 *
 * Ping for new data every 15 mins
 *
 */
setInterval(function () {
  run(moment.utc());
}, 900000);

/**
 *
 * @param targetMoment {Object} moment to check for new data
 */
function run(targetMoment) {
  getGribData(targetMoment).then(function (response) {
    if (response.stamp) {
      convertGribToJson(response.stamp, response.targetMoment);
    }
  });
}

/**
 *
 * Fetches the latest 6 hourly GRIB2 data from NOAA.
 * Checks json-data first; makes only ONE request per cycle to avoid rate limiting.
 *
 * @returns {*|promise}
 */
function getGribData(targetMoment) {
  var deferred = Q.defer();

  var stamp =
    moment(targetMoment).format("YYYYMMDD") +
    roundHours(moment(targetMoment).hour(), 6);

  // check if we already have this stamp in json-data
  if (checkPath("json-data/" + stamp + ".json", false)) {
    console.log("already have " + stamp + ", skipping request");
    deferred.resolve({ stamp: false, targetMoment: false });
    return deferred.promise;
  }

  var dateStr = moment(targetMoment).format("YYYYMMDD");
  var hourStr = roundHours(moment(targetMoment).hour(), 6);

  // make a single request for the current cycle
  request
    .get({
      url: baseDir,
      headers: {
        "User-Agent": requestUserAgent,
      },
      qs: {
        file: "gfs.t" + hourStr + "z.pgrb2.1p00.f000",
        lev_10_m_above_ground: "on",
        lev_surface: "on",
        var_TMP: "on",
        var_UGRD: "on",
        var_VGRD: "on",
        leftlon: 0,
        rightlon: 360,
        toplat: 90,
        bottomlat: -90,
        dir: "/gfs." + dateStr + "/" + hourStr + "/atmos",
      },
    })
    .on("error", function (err) {
      console.log("request error: " + err.message + " | " + stamp);
      deferred.resolve({ stamp: false, targetMoment: false });
    })
    .on("response", function (response) {
      console.log("response " + response.statusCode + " | " + stamp);

      if (response.statusCode != 200) {
        // data not available yet, will retry on next 15-min cycle
        console.log("data not available for " + stamp + ", will retry later");
        deferred.resolve({ stamp: false, targetMoment: false });
      } else {
        // don't rewrite stamps
        if (!checkPath("json-data/" + stamp + ".json", false)) {
          console.log("piping " + stamp);

          // mk sure we've got somewhere to put output
          checkPath("grib-data", true);

          // pipe the file, resolve the valid time stamp
          var file = fs.createWriteStream("grib-data/" + stamp + ".f000");
          response.pipe(file);
          file.on("finish", function () {
            file.close();
            deferred.resolve({ stamp: stamp, targetMoment: targetMoment });
          });
        } else {
          console.log("already have " + stamp + ", not downloading again");
          deferred.resolve({ stamp: false, targetMoment: false });
        }
      }
    });

  return deferred.promise;
}

function convertGribToJson(stamp, targetMoment) {
  // mk sure we've got somewhere to put output
  checkPath("json-data", true);

  var exec = require("child_process").exec,
    child;

  child = exec(
    "converter/bin/grib2json --data --output json-data/" +
      stamp +
      ".json --names --compact grib-data/" +
      stamp +
      ".f000",
    { maxBuffer: 500 * 1024 },
    function (error, stdout, stderr) {
      if (error) {
        console.log("exec error: " + error);
      } else {
        console.log("converted..");

        // don't keep raw grib data
        exec("rm grib-data/*");
      }
    },
  );
}

/**
 *
 * Round hours to expected interval, e.g. we're currently using 6 hourly interval
 * i.e. 00 || 06 || 12 || 18
 *
 * @param hours
 * @param interval
 * @returns {String}
 */
function roundHours(hours, interval) {
  if (interval > 0) {
    var result = Math.floor(hours / interval) * interval;
    return result < 10 ? "0" + result.toString() : result;
  }
}

/**
 * Sync check if path or file exists
 *
 * @param path {string}
 * @param mkdir {boolean} create dir if doesn't exist
 * @returns {boolean}
 */
function checkPath(path, mkdir) {
  try {
    fs.statSync(path);
    return true;
  } catch (e) {
    if (mkdir) {
      fs.mkdirSync(path);
    }
    return false;
  }
}

/**
 * Remove JSON data files older than retentionDays
 */
function cleanupOldData() {
  var dataDir = __dirname + "/json-data";
  var cutoff = moment().subtract(retentionDays, "days");

  try {
    var files = fs.readdirSync(dataDir);
    files.forEach(function (file) {
      if (file.endsWith(".json")) {
        // extract date from filename: YYYYMMDDHH.json
        var stamp = file.replace(".json", "");
        var dateStr = stamp.substring(0, 8);
        var fileMoment = moment(dateStr, "YYYYMMDD");
        if (fileMoment.isBefore(cutoff)) {
          var filePath = dataDir + "/" + file;
          fs.unlinkSync(filePath);
          console.log("cleaned up old data: " + file);
        }
      }
    });
  } catch (e) {
    console.log("cleanup error: " + e.message);
  }
}

// init: clean up old data, then try to fetch current cycle data
cleanupOldData();
run(moment.utc());

// run cleanup once per day
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);
