#!/usr/bin/env node

const log = require("yalm");
const oe = require("obj-ease");
const Mqtt = require("mqtt");
const Hue = require("node-hue-api");
const queue = require("queue");
const pjson = require("persist-json")("hue2mqtt");
const throttle = require("lodash.throttle");
const hsl2rgb = require("./hsl2rgb.js");
const config = require("./config.js");
const pkg = require("./package.json");
const delay200ms = () => new Promise(resolve => setTimeout(resolve, 200));

let mqtt;
let mqttConnected = false;
let bridgeConnected = false;
let bridgeAddress;
let bridgeId;
let bridgeUser;
let hue;
let pollingTimer;
const pollingInterval = (config.pollingInterval || 10) * 1000;
const groupNames = {};
const lightNames = {};
const lightStates = {};
const q = queue();
q.autostart = true;
q.concurrency = 1;

setInterval(() => console.log(q.length), 60000);

function start() {
  log.setLevel(config.verbosity);
  log.info(pkg.name + " " + pkg.version + " starting");

  if (config.bridge) {
    bridgeAddress = config.bridge;
    log.debug("bridge address", bridgeAddress);
    getBridgeId();
  } else {
    Hue.nupnpSearch((err, result) => {
      if (err) {
        log.error("can't find a hue bridge", err.toString());
        process.exit(1);
      } else if (result.length > 0) {
        bridgeAddress = result[0].ipaddress;
        log.info("found bridge on", bridgeAddress);
        getBridgeId();
      } else {
        log.error("can't find a hue bridge");
        process.exit(1);
      }
    });
  }

  log.info("mqtt trying to connect", config.mqttUrl);

  mqtt = Mqtt.connect(
    config.mqttUrl,
    {
      clientId:
        config.name +
        "_" +
        Math.random()
          .toString(16)
          .substr(2, 8),
      will: {
        topic: config.name + "/connected",
        payload: "0",
        retain: config.mqttRetain
      },
      rejectUnauthorized: !config.insecure
    }
  );

  mqtt.on("connect", () => {
    mqttConnected = true;
    log.info("mqtt connected", config.mqttUrl);
    mqtt.publish(config.name + "/connected", bridgeConnected ? "2" : "1", {
      retain: config.mqttRetain
    });
    log.info("mqtt subscribe", config.name + "/set/#");
    mqtt.subscribe(config.name + "/set/#");
  });

  mqtt.on("close", () => {
    if (mqttConnected) {
      mqttConnected = false;
      log.info("mqtt closed " + config.mqttUrl);
    }
  });

  mqtt.on("error", err => {
    log.error("mqtt", err.toString());
  });

  mqtt.on("offline", () => {
    log.error("mqtt offline");
  });

  mqtt.on("reconnect", () => {
    log.info("mqtt reconnect");
  });

  mqtt.on("message", (topic, payload) => {
    payload = payload.toString();
    log.info("mqtt <", topic, payload);

    if (payload.indexOf("{") !== -1) {
      try {
        payload = JSON.parse(payload);
      } catch (err) {
        log.error(err.toString());
      }
    } else if (payload === "false") {
      payload = false;
    } else if (payload === "true") {
      payload = true;
    } else if (!isNaN(payload)) {
      payload = parseFloat(payload);
    }
    const [, method, type, name, datapoint] = topic.split("/");

    switch (method) {
      case "set":
        switch (type) {
          case "lights":
            if (datapoint) {
              setDatapoint(type, name, datapoint, payload);
            } else if (typeof payload === "object") {
              setLightState(name, payload);
            } else {
              setValue(type, name, payload);
            }
            break;

          case "groups":
            if (datapoint) {
              setDatapoint(type, name, datapoint, payload);
            } else if (typeof payload === "object") {
              setGroupLightState(name, payload);
            } else {
              setValue(type, name, payload);
            }
            break;

          default:
            log.error("unknown type", type);
        }
        break;

      default:
        log.error("unknown method", method);
    }
  });
}

function setGroupLightState(name, state) {
  const id = groupNames[name] || name;
  if (id) {
    log.info("hue > setGroupLightState", name, id, state);

    q.push(() =>
      hue
        .setGroupLightState(id, state)
        .then(res => {
          if (!res) {
            log.error("setGroupLightState", name, "failed");
          }
          getLights();
          return delay200ms();
        })
        .catch(err => {
          log.error("setGroupLightState", name, err.toString());
          if (
            err.message.endsWith("is not modifiable. Device is set to off.")
          ) {
            bridgeConnect();
          } else {
            bridgeDisconnect();
          }
        })
    );

    getLights();
  } else {
    log.error("unknown group", name);
  }
}

function setLightState(name, state) {
  let id = lightNames[name];
  if (!id && lightStates[name]) {
    id = name;
  }
  if (id) {
    log.info("hue > setLightState", name, id, state);

    q.push(() =>
      hue
        .setLightState(id, state)
        .then(res => {
          if (res) {
            bridgeConnect();
            publishChanges({ id, state, name });
          } else {
            bridgeConnect();
            log.error("setLightState", name, "failed");
          }
          return delay200ms();
        })
        .catch(err => {
          log.error("setLightState", name, err.toString());
          if (
            err.message.endsWith("is not modifiable. Device is set to off.")
          ) {
            bridgeConnect();
          } else {
            bridgeDisconnect();
          }
        })
    );
  } else {
    log.error("unknown light", name);
  }
}

function setDatapoint(type, name, datapoint, payload) {
  const obj = {};
  obj[datapoint] = payload;
  if (type === "groups") {
    setGroupLightState(name, obj);
  } else if (type === "lights") {
    setLightState(name, obj);
  }
}

function setValue(type, name, payload) {
  if (payload === false) {
    payload = { on: false };
  } else if (payload === true) {
    payload = { on: true };
  } else {
    if (isNaN(payload)) {
      // Ignore
      return;
    }
    payload = parseInt(payload, 10);
    if (payload === 0) {
      payload = { on: false, bri: 0 };
    } else {
      payload = { on: true, bri: payload };
    }
  }
  if (type === "lights") {
    setLightState(name, payload);
  } else if (type === "groups") {
    setGroupLightState(name, payload);
  }
}

function mqttPublish(topic, payload, options) {
  if (!payload) {
    payload = "";
  } else if (typeof payload !== "string") {
    payload = JSON.stringify(payload);
  }
  log.debug("mqtt >", topic, payload);
  mqtt.publish(topic, payload, options);
}

function getBridgeId() {
  log.debug("getBridgeId");
  hue = new Hue.HueApi(bridgeAddress, "none");
  hue.config((err, bridgeConfig) => {
    if (err) {
      log.error("bridge connect", err.toString());
      setTimeout(getBridgeId, pollingInterval);
    } else {
      bridgeId = bridgeConfig.replacesbridgeid || bridgeConfig.bridgeid;
      log.debug("bridge id", bridgeId);
      initApi();
    }
  });
}

function initApi() {
  bridgeUser = pjson.load("user-" + bridgeId);
  hue = new Hue.HueApi(bridgeAddress, bridgeUser);
  if (!bridgeUser) {
    log.warn("no bridge user found");
    registerUser();
    return;
  }
  hue.config((err, bridgeConfig) => {
    if (err) {
      log.error("bridge connect", err.toString());
      setTimeout(initApi, pollingInterval);
    } else {
      bridgeId = bridgeConfig.replacesbridgeid || bridgeConfig.bridgeid;
      log.debug("bridge api version", bridgeConfig.apiversion);
      log.debug("bridge user", bridgeUser);
      if (typeof bridgeConfig.linkbutton === "undefined") {
        log.error("username not known to bridge");
        registerUser();
      } else {
        bridgeConnect();
        if (
          bridgeConfig.swupdate.updatestate &&
          bridgeConfig.swupdate.devicetypes.bridge
        ) {
          log.warn("bridge update available:", bridgeConfig.swupdate.text);
        }
        getGroups();
        getLights();
      }
    }
  });
}

function registerUser() {
  hue.createUser(bridgeAddress, "hue2mqtt.js", (err, user) => {
    if (err) {
      if (err.toString() === "Api Error: link button not pressed") {
        log.warn("please press the link button");
        mqttPublish("hue/status/authrequired");
        setTimeout(registerUser, 5000);
      } else {
        log.error(err.toString());
      }
    } else {
      log.info("got username", user);
      pjson.save("user-" + bridgeId, user);
      initApi();
    }
  });
}

function bridgeConnect() {
  if (!bridgeConnected) {
    bridgeConnected = true;
    log.info("bridge connected");
    mqttPublish(config.name + "/connected", "2", { retain: config.mqttRetain });
  }
}

function bridgeDisconnect() {
  if (bridgeConnected) {
    bridgeConnected = false;
    log.error("bridge disconnected");
    mqttPublish(config.name + "/connected", "1", { retain: config.mqttRetain });
  }
}

setInterval(() => {
  getLights();
}, pollingInterval);

const getLights = throttle(
  function getLights() {
    log.debug("hue > getLights");

    hue
      .lights()
      .then(res => {
        if (res.lights && res.lights.length > 0) {
          bridgeConnect();
          res.lights.forEach(light => {
            lightNames[light.name] = light.id;
            publishChanges(light);
          });
        }
      })
      .catch(err => {
        const errStr = err.toString();
        log.error("getLights", errStr);
        if (errStr === "Error: read ECONNRESET") {
          log.error("Ending process");
          process.exit(1);
        }
        bridgeDisconnect();
      });
  },
  1000,
  { leading: false, trailing: true }
);

function getGroups(callback) {
  log.info("hue > getGroups");

  q.push(() =>
    hue
      .groups()
      .then(res => {
        if (res && res.length > 0) {
          log.debug("got", res.length, "groups");
          res.forEach(group => {
            groupNames[group.name] = group.id;
          });
        }
        if (typeof callback === "function") {
          callback();
        }
      })
      .catch(err => {
        log.error(err.toString());
        bridgeDisconnect();
      })
  );
}

function publishChanges(light) {
  const allowedDatapoints = [
    "on",
    "bri",
    "hue",
    "sat",
    "xy",
    "ct",
    "colormode",
    "reachable",
    "effect",
    "alert"
  ];
  if (!lightStates[light.id]) {
    lightStates[light.id] = {};
  }
  Object.keys(light.state).forEach(dp => {
    if (allowedDatapoints.indexOf(dp) === -1) {
      delete light.state[dp];
    }
  });
  const changes = oe.extend(lightStates[light.id], light.state);
  if (changes) {
    let defaultVal;
    if (typeof lightStates[light.id].bri === "undefined") {
      defaultVal = lightStates[light.id].on;
    } else {
      defaultVal = lightStates[light.id].on ? lightStates[light.id].bri : 0;
    }
    const payload = {
      val: defaultVal,
      hue_state: lightStates[light.id] // eslint-disable-line camelcase
    };
    const topic =
      config.name +
      "/status/lights/" +
      (config.disableNames ? light.id : light.name);
    mqttPublish(topic, payload, { retain: config.mqttRetain });

    if (config.publishDistinct) {
      let rgbChange = false;
      Object.keys(changes).forEach(datapoint => {
        if (
          lightStates[light.id] !== "ct" &&
          ["bri", "hue", "sat", "xy", "ct"].indexOf(datapoint) !== -1
        ) {
          rgbChange = true;
        } else if (
          lightStates[light.id] === "ct" &&
          ["bri", "ct"].indexOf(datapoint) !== -1
        ) {
          rgbChange = true;
        }
        mqttPublish(
          topic + "/" + datapoint,
          { val: changes[datapoint] },
          { retain: config.mqttRetain }
        );
      });
      if (rgbChange && lightStates[light.id].colormode === "ct") {
        const c = Math.floor((lightStates[light.id].ct - 153) / 1.2) - 60;
        let f;
        let color;
        if (c < 0) {
          f = 255 + c;
          color =
            (0 + f.toString(16)).slice(-2) +
            (0 + f.toString(16)).slice(-2) +
            "ff";
        } else {
          f = 255 - c;
          color = "ffff" + (0 + f.toString(16)).slice(-2);
        }
        mqttPublish(
          topic + "/rgb",
          { val: color },
          { retain: config.mqttRetain }
        );
      } else if (rgbChange) {
        mqttPublish(
          topic + "/rgb",
          {
            val: hsl2rgb(
              (lightStates[light.id].hue / 65535) * 360,
              lightStates[light.id].sat / 254,
              lightStates[light.id].bri / 254
            )
          },
          { retain: config.mqttRetain }
        );
      }
    }
  }
}

start();