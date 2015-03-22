/* jshint moz:true, browser:true */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PeerConnectionIdp",
  "resource://gre/modules/media/PeerConnectionIdp.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "convertToRTCStatsReport",
  "resource://gre/modules/media/RTCStatsReport.jsm");

const PC_CONTRACT = "@mozilla.org/dom/peerconnection;1";
const PC_OBS_CONTRACT = "@mozilla.org/dom/peerconnectionobserver;1";
const PC_ICE_CONTRACT = "@mozilla.org/dom/rtcicecandidate;1";
const PC_SESSION_CONTRACT = "@mozilla.org/dom/rtcsessiondescription;1";
const PC_MANAGER_CONTRACT = "@mozilla.org/dom/peerconnectionmanager;1";
const PC_STATS_CONTRACT = "@mozilla.org/dom/rtcstatsreport;1";
const PC_IDENTITY_CONTRACT = "@mozilla.org/dom/rtcidentityassertion;1";
const PC_STATIC_CONTRACT = "@mozilla.org/dom/peerconnectionstatic;1";
const PC_SENDER_CONTRACT = "@mozilla.org/dom/rtpsender;1";
const PC_RECEIVER_CONTRACT = "@mozilla.org/dom/rtpreceiver;1";

const PC_CID = Components.ID("{bdc2e533-b308-4708-ac8e-a8bfade6d851}");
const PC_OBS_CID = Components.ID("{d1748d4c-7f6a-4dc5-add6-d55b7678537e}");
const PC_ICE_CID = Components.ID("{02b9970c-433d-4cc2-923d-f7028ac66073}");
const PC_SESSION_CID = Components.ID("{1775081b-b62d-4954-8ffe-a067bbf508a7}");
const PC_MANAGER_CID = Components.ID("{7293e901-2be3-4c02-b4bd-cbef6fc24f78}");
const PC_STATS_CID = Components.ID("{7fe6e18b-0da3-4056-bf3b-440ef3809e06}");
const PC_IDENTITY_CID = Components.ID("{1abc7499-3c54-43e0-bd60-686e2703f072}");
const PC_STATIC_CID = Components.ID("{0fb47c47-a205-4583-a9fc-cbadf8c95880}");
const PC_SENDER_CID = Components.ID("{4fff5d46-d827-4cd4-a970-8fd53977440e}");
const PC_RECEIVER_CID = Components.ID("{d974b814-8fde-411c-8c45-b86791b81030}");

// Global list of PeerConnection objects, so they can be cleaned up when
// a page is torn down. (Maps inner window ID to an array of PC objects).
function GlobalPCList() {
  this._list = {};
  this._networkdown = false; // XXX Need to query current state somehow
  this._lifecycleobservers = {};
  Services.obs.addObserver(this, "inner-window-destroyed", true);
  Services.obs.addObserver(this, "profile-change-net-teardown", true);
  Services.obs.addObserver(this, "network:offline-about-to-go-offline", true);
  Services.obs.addObserver(this, "network:offline-status-changed", true);
  Services.obs.addObserver(this, "gmp-plugin-crash", true);
}
GlobalPCList.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                         Ci.nsISupportsWeakReference,
                                         Ci.IPeerConnectionManager]),
  classID: PC_MANAGER_CID,
  _xpcom_factory: {
    createInstance: function(outer, iid) {
      if (outer) {
        throw Cr.NS_ERROR_NO_AGGREGATION;
      }
      return _globalPCList.QueryInterface(iid);
    }
  },

  notifyLifecycleObservers: function(pc, type) {
    for (var key of Object.keys(this._lifecycleobservers)) {
      this._lifecycleobservers[key](pc, pc._winID, type);
    }
  },

  addPC: function(pc) {
    let winID = pc._winID;
    if (this._list[winID]) {
      this._list[winID].push(Cu.getWeakReference(pc));
    } else {
      this._list[winID] = [Cu.getWeakReference(pc)];
    }
    this.removeNullRefs(winID);
  },

  removeNullRefs: function(winID) {
    if (this._list[winID] === undefined) {
      return;
    }
    this._list[winID] = this._list[winID].filter(
      function (e,i,a) { return e.get() !== null; });

    if (this._list[winID].length === 0) {
      delete this._list[winID];
    }
  },

  hasActivePeerConnection: function(winID) {
    this.removeNullRefs(winID);
    return this._list[winID] ? true : false;
  },

  observe: function(subject, topic, data) {
    let cleanupPcRef = function(pcref) {
      let pc = pcref.get();
      if (pc) {
        pc._pc.close();
        delete pc._observer;
        pc._pc = null;
      }
    };

    let cleanupWinId = function(list, winID) {
      if (list.hasOwnProperty(winID)) {
        list[winID].forEach(cleanupPcRef);
        delete list[winID];
      }
    };

    let broadcastPluginCrash = function(list, winID, pluginID, name, crashReportID) {
      if (list.hasOwnProperty(winID)) {
        list[winID].forEach(function(pcref) {
          let pc = pcref.get();
          if (pc) {
            pc._pc.pluginCrash(pluginID, name, crashReportID);
          }
        });
      }
    };

    if (topic == "inner-window-destroyed") {
      let winID = subject.QueryInterface(Ci.nsISupportsPRUint64).data;
      cleanupWinId(this._list, winID);

      if (this._lifecycleobservers.hasOwnProperty(winID)) {
        delete this._lifecycleobservers[winID];
      }
    } else if (topic == "profile-change-net-teardown" ||
               topic == "network:offline-about-to-go-offline") {
      // Delete all peerconnections on shutdown - mostly synchronously (we
      // need them to be done deleting transports and streams before we
      // return)! All socket operations must be queued to STS thread
      // before we return to here.
      // Also kill them if "Work Offline" is selected - more can be created
      // while offline, but attempts to connect them should fail.
      for (let winId in this._list) {
        cleanupWinId(this._list, winId);
      }
      this._networkdown = true;
    }
    else if (topic == "network:offline-status-changed") {
      if (data == "offline") {
        // this._list shold be empty here
        this._networkdown = true;
      } else if (data == "online") {
        this._networkdown = false;
      }
    } else if (topic == "network:app-offline-status-changed") {
      // App just went offline. The subject also contains the appId,
      // but navigator.onLine checks that for us
      if (!this._networkdown && !this._win.navigator.onLine) {
        for (let winId in this._list) {
          cleanupWinId(this._list, winId);
        }
      }
      this._networkdown = !this._win.navigator.onLine;
    } else if (topic == "gmp-plugin-crash") {
      // a plugin crashed; if it's associated with any of our PCs, fire an
      // event to the DOM window
      let sep = data.indexOf(' ');
      let pluginId = data.slice(0, sep);
      let rest = data.slice(sep+1);
      // This presumes no spaces in the name!
      sep = rest.indexOf(' ');
      let name = rest.slice(0, sep);
      let crashId = rest.slice(sep+1);
      for (let winId in this._list) {
        broadcastPluginCrash(this._list, winId, pluginId, name, crashId);
      }
    }
  },

  _registerPeerConnectionLifecycleCallback: function(winID, cb) {
    this._lifecycleobservers[winID] = cb;
  },
};
let _globalPCList = new GlobalPCList();

function RTCIceCandidate() {
  this.candidate = this.sdpMid = this.sdpMLineIndex = null;
}
RTCIceCandidate.prototype = {
  classDescription: "mozRTCIceCandidate",
  classID: PC_ICE_CID,
  contractID: PC_ICE_CONTRACT,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports,
                                         Ci.nsIDOMGlobalPropertyInitializer]),

  init: function(win) { this._win = win; },

  __init: function(dict) {
    this.candidate = dict.candidate;
    this.sdpMid = dict.sdpMid;
    this.sdpMLineIndex = ("sdpMLineIndex" in dict)? dict.sdpMLineIndex : null;
  }
};

function RTCSessionDescription() {
  this.type = this.sdp = null;
}
RTCSessionDescription.prototype = {
  classDescription: "mozRTCSessionDescription",
  classID: PC_SESSION_CID,
  contractID: PC_SESSION_CONTRACT,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports,
                                         Ci.nsIDOMGlobalPropertyInitializer]),

  init: function(win) { this._win = win; },

  __init: function(dict) {
    this.type = dict.type;
    this.sdp  = dict.sdp;
  }
};

function RTCStatsReport(win, dict) {
  this._win = win;
  this._pcid = dict.pcid;
  this._report = convertToRTCStatsReport(dict);
}
RTCStatsReport.prototype = {
  classDescription: "RTCStatsReport",
  classID: PC_STATS_CID,
  contractID: PC_STATS_CONTRACT,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports]),

  // TODO: Change to use webidl getters once available (Bug 952122)
  //
  // Since webidl getters are not available, we make the stats available as
  // enumerable read-only properties directly on our content-facing object.
  // Must be called after our webidl sandwich is made.

  makeStatsPublic: function() {
    let props = {};
    this.forEach(function(stat) {
        props[stat.id] = { enumerable: true, configurable: false,
                           writable: false, value: stat };
      });
    Object.defineProperties(this.__DOM_IMPL__.wrappedJSObject, props);
  },

  forEach: function(cb, thisArg) {
    for (var key in this._report) {
      cb.call(thisArg || this._report, this.get(key), key, this._report);
    }
  },

  get: function(key) {
    function publifyReadonly(win, obj) {
      let props = {};
      for (let k in obj) {
        props[k] = {enumerable:true, configurable:false, writable:false, value:obj[k]};
      }
      let pubobj = Cu.createObjectIn(win);
      Object.defineProperties(pubobj, props);
      return pubobj;
    }

    // Return a content object rather than a wrapped chrome one.
    return publifyReadonly(this._win, this._report[key]);
  },

  has: function(key) {
    return this._report[key] !== undefined;
  },

  get mozPcid() { return this._pcid; }
};

function RTCIdentityAssertion() {}
RTCIdentityAssertion.prototype = {
  classDescription: "RTCIdentityAssertion",
  classID: PC_IDENTITY_CID,
  contractID: PC_IDENTITY_CONTRACT,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports,
                                         Ci.nsIDOMGlobalPropertyInitializer]),

  init: function(win) { this._win = win; },

  __init: function(idp, name) {
    this.idp = idp;
    this.name  = name;
  }
};

function RTCPeerConnection() {
  this._senders = [];
  this._receivers = [];

  this._pc = null;
  this._observer = null;
  this._closed = false;

  this._onCreateOfferSuccess = null;
  this._onCreateOfferFailure = null;
  this._onCreateAnswerSuccess = null;
  this._onCreateAnswerFailure = null;
  this._onGetStatsSuccess = null;
  this._onGetStatsFailure = null;
  this._onReplaceTrackSender = null;
  this._onReplaceTrackWithTrack = null;
  this._onReplaceTrackSuccess = null;
  this._onReplaceTrackFailure = null;

  this._localType = null;
  this._remoteType = null;
  this._peerIdentity = null;

  // States
  this._iceGatheringState = this._iceConnectionState = "new";
}
RTCPeerConnection.prototype = {
  classDescription: "mozRTCPeerConnection",
  classID: PC_CID,
  contractID: PC_CONTRACT,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports,
                                         Ci.nsIDOMGlobalPropertyInitializer]),
  init: function(win) { this._win = win; },

  __init: function(rtcConfig) {
    if (!rtcConfig.iceServers ||
        !Services.prefs.getBoolPref("media.peerconnection.use_document_iceservers")) {
      rtcConfig.iceServers =
        JSON.parse(Services.prefs.getCharPref("media.peerconnection.default_iceservers"));
    }
    this._winID = this._win.QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIDOMWindowUtils).currentInnerWindowID;
    this._mustValidateRTCConfiguration(rtcConfig,
        "RTCPeerConnection constructor passed invalid RTCConfiguration");
    if (_globalPCList._networkdown || !this._win.navigator.onLine) {
      throw new this._win.DOMError("InvalidStateError",
          "Can't create RTCPeerConnections when the network is down");
    }

    this.makeGetterSetterEH("onaddstream");
    this.makeGetterSetterEH("onaddtrack");
    this.makeGetterSetterEH("onicecandidate");
    this.makeGetterSetterEH("onnegotiationneeded");
    this.makeGetterSetterEH("onsignalingstatechange");
    this.makeGetterSetterEH("onremovestream");
    this.makeGetterSetterEH("ondatachannel");
    this.makeGetterSetterEH("oniceconnectionstatechange");
    this.makeGetterSetterEH("onidentityresult");
    this.makeGetterSetterEH("onpeeridentity");
    this.makeGetterSetterEH("onidpassertionerror");
    this.makeGetterSetterEH("onidpvalidationerror");

    this._pc = new this._win.PeerConnectionImpl();
    this._taskChain = this._win.Promise.resolve();

    this.__DOM_IMPL__._innerObject = this;
    this._observer = new this._win.PeerConnectionObserver(this.__DOM_IMPL__);

    // Add a reference to the PeerConnection to global list (before init).
    _globalPCList.addPC(this);

    this._impl.initialize(this._observer, this._win, rtcConfig,
                          Services.tm.currentThread);
    this._initIdp();
    _globalPCList.notifyLifecycleObservers(this, "initialized");
  },

  get _impl() {
    if (!this._pc) {
      throw new this._win.DOMError("InvalidStateError",
          "RTCPeerConnection is gone (did you enter Offline mode?)");
    }
    return this._pc;
  },

  _initIdp: function() {
    let prefName = "media.peerconnection.identity.timeout";
    let idpTimeout = Services.prefs.getIntPref(prefName);
    let warningFunc = this.logWarning.bind(this);
    this._localIdp = new PeerConnectionIdp(this._win, idpTimeout, warningFunc,
                                           this.dispatchEvent.bind(this));
    this._remoteIdp = new PeerConnectionIdp(this._win, idpTimeout, warningFunc,
                                            this.dispatchEvent.bind(this));
  },

  /**
   * Add a function to the task chain.
   *   onSuccess - legacy callback (optional)
   *   onError   - legacy callback (optional)
   */
  _queue: function(func, onSuccess, onError) {
    let p = this._taskChain.then(() => {
      this._checkClosed(); // TODO: Move outside promise once Bug 1107592 is fixed.
      return func();
    });
    this._taskChain = p.catch(() => {}); // don't propagate errors in taskChain!
    return onSuccess? p.then(this._wrapLegacyCallback(onSuccess),
                             this._wrapLegacyCallback(onError)) : p;
  },

  _wrapLegacyCallback: function(func) {
    return result => {
      try {
        func && func(result);
      } catch (e) {
        this.logErrorAndCallOnError(e);
      }
    };
  },

  /**
   * An RTCConfiguration looks like this:
   *
   * { "iceServers": [ { url:"stun:stun.example.org" },
   *                   { url:"turn:turn.example.org",
   *                     username:"jib", credential:"mypass"} ] }
   *
   * WebIDL normalizes structure for us, so we test well-formed stun/turn urls,
   * but not validity of servers themselves, before passing along to C++.
   * ErrorMsg is passed in to detail which array-entry failed, if any.
   */
  _mustValidateRTCConfiguration: function(rtcConfig, errorMsg) {
    var errorCtor = this._win.DOMError;
    var warningFunc = this.logWarning.bind(this);
    function nicerNewURI(uriStr, errorMsg) {
      let ios = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
      try {
        return ios.newURI(uriStr, null, null);
      } catch (e if (e.result == Cr.NS_ERROR_MALFORMED_URI)) {
        throw new errorCtor("", errorMsg + " - malformed URI: " + uriStr);
      }
    }
    function mustValidateServer(server) {
      if (!server.url) {
        throw new errorCtor("", errorMsg + " - missing url");
      }
      let url = nicerNewURI(server.url, errorMsg);
      if (url.scheme in { turn:1, turns:1 }) {
        if (!server.username) {
          throw new errorCtor("", errorMsg + " - missing username: " + server.url);
        }
        if (!server.credential) {
          throw new errorCtor("", errorMsg + " - missing credential: " +
                              server.url);
        }
      }
      else if (!(url.scheme in { stun:1, stuns:1 })) {
        throw new errorCtor("", errorMsg + " - improper scheme: " + url.scheme);
      }
      if (url.scheme in { stuns:1, turns:1 }) {
        warningFunc(url.scheme.toUpperCase() + " is not yet supported.", null, 0);
      }
    }
    if (rtcConfig.iceServers) {
      let len = rtcConfig.iceServers.length;
      for (let i=0; i < len; i++) {
        mustValidateServer (rtcConfig.iceServers[i], errorMsg);
      }
    }
  },

  // Ideally, this should be of the form _checkState(state),
  // where the state is taken from an enumeration containing
  // the valid peer connection states defined in the WebRTC
  // spec. See Bug 831756.
  _checkClosed: function() {
    if (this._closed) {
      throw new this._win.DOMError("InvalidStateError", "Peer connection is closed");
    }
  },

  dispatchEvent: function(event) {
    // PC can close while events are firing if there is an async dispatch
    // in c++ land
    if (!this._closed) {
      this.__DOM_IMPL__.dispatchEvent(event);
    }
  },

  // Log error message to web console and window.onerror, if present.
  logErrorAndCallOnError: function(e) {
    this.logMsg(e.message, e.fileName, e.lineNumber, Ci.nsIScriptError.exceptionFlag);

    // Safely call onerror directly if present (necessary for testing)
    try {
      if (typeof this._win.onerror === "function") {
        this._win.onerror(e.message, e.fileName, e.lineNumber);
      }
    } catch(e) {
      // If onerror itself throws, service it.
      try {
        this.logError(e.message, e.fileName, e.lineNumber);
      } catch(e) {}
    }
  },

  logError: function(msg, file, line) {
    this.logMsg(msg, file, line, Ci.nsIScriptError.errorFlag);
  },

  logWarning: function(msg, file, line) {
    this.logMsg(msg, file, line, Ci.nsIScriptError.warningFlag);
  },

  logMsg: function(msg, file, line, flag) {
    let scriptErrorClass = Cc["@mozilla.org/scripterror;1"];
    let scriptError = scriptErrorClass.createInstance(Ci.nsIScriptError);
    scriptError.initWithWindowID(msg, file, null, line, 0, flag,
                                 "content javascript", this._winID);
    let console = Cc["@mozilla.org/consoleservice;1"].
      getService(Ci.nsIConsoleService);
    console.logMessage(scriptError);
  },

  getEH: function(type) {
    return this.__DOM_IMPL__.getEventHandler(type);
  },

  setEH: function(type, handler) {
    this.__DOM_IMPL__.setEventHandler(type, handler);
  },

  makeGetterSetterEH: function(name) {
    Object.defineProperty(this, name,
                          {
                            get:function()  { return this.getEH(name); },
                            set:function(h) { return this.setEH(name, h); }
                          });
  },

  createOffer: function(optionsOrOnSuccess, onError, options) {

    // TODO: Remove old constraint-like RTCOptions support soon (Bug 1064223).
    // Note that webidl bindings make o.mandatory implicit but not o.optional.
    function convertLegacyOptions(o) {
      // Detect (mandatory OR optional) AND no other top-level members.
      let lcy = ((o.mandatory && Object.keys(o.mandatory).length) || o.optional) &&
                Object.keys(o).length == (o.mandatory? 1 : 0) + (o.optional? 1 : 0);
      if (!lcy) {
        return false;
      }
      let old = o.mandatory || {};
      if (o.mandatory) {
        delete o.mandatory;
      }
      if (o.optional) {
        o.optional.forEach(one => {
          // The old spec had optional as an array of objects w/1 attribute each.
          // Assumes our JS-webidl bindings only populate passed-in properties.
          let key = Object.keys(one)[0];
          if (key && old[key] === undefined) {
            old[key] = one[key];
          }
        });
        delete o.optional;
      }
      o.offerToReceiveAudio = old.OfferToReceiveAudio;
      o.offerToReceiveVideo = old.OfferToReceiveVideo;
      o.mozDontOfferDataChannel = old.MozDontOfferDataChannel;
      o.mozBundleOnly = old.MozBundleOnly;
      Object.keys(o).forEach(k => {
        if (o[k] === undefined) {
          delete o[k];
        }
      });
      return true;
    }

    let onSuccess;
    if (optionsOrOnSuccess && typeof optionsOrOnSuccess === "function") {
      onSuccess = optionsOrOnSuccess;
    } else {
      options = optionsOrOnSuccess;
      onError = undefined;
    }
    if (options && convertLegacyOptions(options)) {
      this.logWarning(
          "Mandatory/optional in createOffer options is deprecated! Use " +
          JSON.stringify(options) + " instead (note the case difference)!",
          null, 0);
    }
    return this._queue(() => this._createOffer(options), onSuccess, onError);
  },

  _createOffer: function(options) {
    return new this._win.Promise((resolve, reject) => {
      this._onCreateOfferSuccess = resolve;
      this._onCreateOfferFailure = reject;
      this._impl.createOffer(options);
    });
  },

  _createAnswer: function() {
    return new this._win.Promise((resolve, reject) => {
      if (!this.remoteDescription) {
        throw new this._win.DOMError("InvalidStateError",
                                     "setRemoteDescription not called");
      }
      if (this.remoteDescription.type != "offer") {
        throw new this._win.DOMError("InvalidStateError",
                                     "No outstanding offer");
      }
      this._onCreateAnswerSuccess = resolve;
      this._onCreateAnswerFailure = reject;
      this._impl.createAnswer();
    });
  },

  createAnswer: function(onSuccess, onError) {
    return this._queue(() => this._createAnswer(), onSuccess, onError);
  },

  setLocalDescription: function(desc, onSuccess, onError) {
    this._localType = desc.type;

    let type;
    switch (desc.type) {
      case "offer":
        type = Ci.IPeerConnection.kActionOffer;
        break;
      case "answer":
        type = Ci.IPeerConnection.kActionAnswer;
        break;
      case "pranswer":
        throw new this._win.DOMError("NotSupportedError", "pranswer not yet implemented");
      default:
        throw new this._win.DOMError("InvalidParameterError",
            "Invalid type " + desc.type + " provided to setLocalDescription");
    }

    return this._queue(() => this._setLocalDescription(type, desc.sdp),
                       onSuccess, onError);
  },

  _setLocalDescription: function(type, sdp) {
    return new this._win.Promise((resolve, reject) => {
      this._onSetLocalDescriptionSuccess = resolve;
      this._onSetLocalDescriptionFailure = reject;
      this._impl.setLocalDescription(type, sdp);
    });
  },

  setRemoteDescription: function(desc, onSuccess, onError) {
    this._remoteType = desc.type;

    let type;
    switch (desc.type) {
      case "offer":
        type = Ci.IPeerConnection.kActionOffer;
        break;
      case "answer":
        type = Ci.IPeerConnection.kActionAnswer;
        break;
      case "pranswer":
        throw new this._win.DOMError("NotSupportedError", "pranswer not yet implemented");
      default:
        throw new this._win.DOMError("InvalidParameterError",
            "Invalid type " + desc.type + " provided to setRemoteDescription");
    }

    // Have to get caller's origin outside of Promise constructor and pass it in
    let origin = Cu.getWebIDLCallerPrincipal().origin;

    return this._queue(() => this._setRemoteDescription(type, desc.sdp, origin),
                       onSuccess, onError);
  },

  /**
   * Takes a result from the IdP and checks it against expectations.
   * If OK, generates events.
   * Returns true if it is either present and valid, or if there is no
   * need for identity.
   */
  _processIdpResult: function(message) {
    let good = !!message;
    // This might be a valid assertion, but if we are constrained to a single peer
    // identity, then we also need to make sure that the assertion matches
    if (good && this._impl.peerIdentity) {
      good = (message.identity === this._impl.peerIdentity);
    }
    if (good) {
      this._impl.peerIdentity = message.identity;
      this._peerIdentity = new this._win.RTCIdentityAssertion(
        this._remoteIdp.provider, message.identity);
      this.dispatchEvent(new this._win.Event("peeridentity"));
    }
    return good;
  },

  _setRemoteDescription: function(type, sdp, origin) {
    return new this._win.Promise((resolve, reject) =>
      this._setRemoteDescriptionImpl(type, sdp, origin, resolve, reject));
  },

  _setRemoteDescriptionImpl: function(type, sdp, origin, onSuccess, onError) {
    let idpComplete = false;
    let setRemoteComplete = false;
    let idpError = null;
    let isDone = false;

    // we can run the IdP validation in parallel with setRemoteDescription this
    // complicates much more than would be ideal, but it ensures that the IdP
    // doesn't hold things up too much when it's not on the critical path
    let allDone = () => {
      if (!setRemoteComplete || !idpComplete || isDone) {
        return;
      }
      // May be null if the user didn't supply success/failure callbacks.
      // Violation of spec, but we allow it for now
      onSuccess();
      isDone = true;
    };

    let setRemoteDone = () => {
      setRemoteComplete = true;
      allDone();
    };

    // If we aren't waiting for something specific, allow this
    // to complete asynchronously.
    let idpDone;
    if (!this._impl.peerIdentity) {
      idpDone = this._processIdpResult.bind(this);
      idpComplete = true; // lie about this for allDone()
    } else {
      idpDone = message => {
        let idpGood = this._processIdpResult(message);
        if (!idpGood) {
          // iff we are waiting for a very specific peerIdentity
          // call the error callback directly and then close
          idpError = "Peer Identity mismatch, expected: " +
            this._impl.peerIdentity;
          onError(idpError);
          this.close();
        } else {
          idpComplete = true;
          allDone();
        }
      };
    }

    try {
      this._remoteIdp.verifyIdentityFromSDP(sdp, origin, idpDone);
    } catch (e) {
      // if processing the SDP for identity doesn't work
      this.logWarning(e.message, e.fileName, e.lineNumber);
      idpDone(null);
    }

    this._onSetRemoteDescriptionSuccess = setRemoteDone;
    this._onSetRemoteDescriptionFailure = onError;
    this._impl.setRemoteDescription(type, sdp);
  },

  setIdentityProvider: function(provider, protocol, username) {
    this._checkClosed();
    this._localIdp.setIdentityProvider(provider, protocol, username);
  },

  _gotIdentityAssertion: function(assertion){
    let args = { assertion: assertion };
    let ev = new this._win.RTCPeerConnectionIdentityEvent("identityresult", args);
    this.dispatchEvent(ev);
  },

  getIdentityAssertion: function() {
    this._checkClosed();

    var gotAssertion = assertion => {
      if (assertion) {
        this._gotIdentityAssertion(assertion);
      }
    };

    this._localIdp.getIdentityAssertion(this._impl.fingerprint,
                                        gotAssertion);
  },

  updateIce: function(config) {
    throw new this._win.DOMError("NotSupportedError", "updateIce not yet implemented");
  },

  addIceCandidate: function(cand, onSuccess, onError) {
    if (!cand.candidate && !cand.sdpMLineIndex) {
      throw new this._win.DOMError("InvalidParameterError",
          "Invalid candidate passed to addIceCandidate!");
    }
    return this._queue(() => this._addIceCandidate(cand), onSuccess, onError);
  },

  _addIceCandidate: function(cand) {
    return new this._win.Promise((resolve, reject) => {
      this._onAddIceCandidateSuccess = resolve;
      this._onAddIceCandidateError = reject;

      this._impl.addIceCandidate(cand.candidate, cand.sdpMid || "",
                                 cand.sdpMLineIndex);
    });
  },

  addStream: function(stream) {
    stream.getTracks().forEach(track => this.addTrack(track, stream));
  },

  removeStream: function(stream) {
     // Bug 844295: Not implementing this functionality.
     throw new this._win.DOMError("NotSupportedError", "removeStream not yet implemented");
  },

  getStreamById: function(id) {
    throw new this._win.DOMError("NotSupportedError", "getStreamById not yet implemented");
  },

  addTrack: function(track, stream) {
    if (stream.currentTime === undefined) {
      throw new this._win.DOMError("InvalidParameterError", "invalid stream.");
    }
    if (stream.getTracks().indexOf(track) == -1) {
      throw new this._win.DOMError("InvalidParameterError", "track is not in stream.");
    }
    this._checkClosed();
    this._impl.addTrack(track, stream);
    let sender = this._win.RTCRtpSender._create(this._win,
                                                new RTCRtpSender(this, track,
                                                                 stream));
    this._senders.push({ sender: sender, stream: stream });
    return sender;
  },

  removeTrack: function(sender) {
     // Bug 844295: Not implementing this functionality.
     throw new this._win.DOMError("NotSupportedError", "removeTrack not yet implemented");
  },

  _replaceTrack: function(sender, withTrack) {
    // TODO: Do a (sender._stream.getTracks().indexOf(track) == -1) check
    //       on both track args someday.
    //
    // The proposed API will be that both tracks must already be in the same
    // stream. However, since our MediaStreams currently are limited to one
    // track per type, we allow replacement with an outside track not already
    // in the same stream.
    //
    // Since a track may be replaced more than once, the track being replaced
    // may not be in the stream either, so we check neither arg right now.

    return new this._win.Promise((resolve, reject) => {
      this._onReplaceTrackSender = sender;
      this._onReplaceTrackWithTrack = withTrack;
      this._onReplaceTrackSuccess = resolve;
      this._onReplaceTrackFailure = reject;
      this._impl.replaceTrack(sender.track, withTrack, sender._stream);
    });
  },

  close: function() {
    if (this._closed) {
      return;
    }
    this.changeIceConnectionState("closed");
    this._localIdp.close();
    this._remoteIdp.close();
    this._impl.close();
    this._closed = true;
  },

  getLocalStreams: function() {
    this._checkClosed();
    return this._impl.getLocalStreams();
  },

  getRemoteStreams: function() {
    this._checkClosed();
    return this._impl.getRemoteStreams();
  },

  getSenders: function() {
    this._checkClosed();
    let streams = this._impl.getLocalStreams();
    let senders = [];
    // prune senders in case any streams have disappeared down below
    for (let i = this._senders.length - 1; i >= 0; i--) {
      if (streams.indexOf(this._senders[i].stream) != -1) {
        senders.push(this._senders[i].sender);
      } else {
        this._senders.splice(i,1);
      }
    }
    return senders;
  },

  getReceivers: function() {
    this._checkClosed();
    let streams = this._impl.getRemoteStreams();
    let receivers = [];
    // prune receivers in case any streams have disappeared down below
    for (let i = this._receivers.length - 1; i >= 0; i--) {
      if (streams.indexOf(this._receivers[i].stream) != -1) {
        receivers.push(this._receivers[i].receiver);
      } else {
        this._receivers.splice(i,1);
      }
    }
    return receivers;
  },

  get localDescription() {
    this._checkClosed();
    let sdp = this._impl.localDescription;
    if (sdp.length == 0) {
      return null;
    }

    sdp = this._localIdp.wrapSdp(sdp);
    return new this._win.mozRTCSessionDescription({ type: this._localType,
                                                    sdp: sdp });
  },

  get remoteDescription() {
    this._checkClosed();
    let sdp = this._impl.remoteDescription;
    if (sdp.length == 0) {
      return null;
    }
    return new this._win.mozRTCSessionDescription({ type: this._remoteType,
                                                    sdp: sdp });
  },

  get peerIdentity() { return this._peerIdentity; },
  get id() { return this._impl.id; },
  set id(s) { this._impl.id = s; },
  get iceGatheringState()  { return this._iceGatheringState; },
  get iceConnectionState() { return this._iceConnectionState; },

  get signalingState() {
    // checking for our local pc closed indication
    // before invoking the pc methods.
    if (this._closed) {
      return "closed";
    }
    return {
      "SignalingInvalid":            "",
      "SignalingStable":             "stable",
      "SignalingHaveLocalOffer":     "have-local-offer",
      "SignalingHaveRemoteOffer":    "have-remote-offer",
      "SignalingHaveLocalPranswer":  "have-local-pranswer",
      "SignalingHaveRemotePranswer": "have-remote-pranswer",
      "SignalingClosed":             "closed"
    }[this._impl.signalingState];
  },

  changeIceGatheringState: function(state) {
    this._iceGatheringState = state;
    _globalPCList.notifyLifecycleObservers(this, "icegatheringstatechange");
  },

  changeIceConnectionState: function(state) {
    this._iceConnectionState = state;
    _globalPCList.notifyLifecycleObservers(this, "iceconnectionstatechange");
    this.dispatchEvent(new this._win.Event("iceconnectionstatechange"));
  },

  getStats: function(selector, onSuccess, onError) {
    return this._queue(() => this._getStats(selector), onSuccess, onError);
  },

  _getStats: function(selector) {
    return new this._win.Promise((resolve, reject) => {
      this._onGetStatsSuccess = resolve;
      this._onGetStatsFailure = reject;
      this._impl.getStats(selector);
    });
  },

  createDataChannel: function(label, dict) {
    this._checkClosed();
    if (dict == undefined) {
      dict = {};
    }
    if (dict.maxRetransmitNum != undefined) {
      dict.maxRetransmits = dict.maxRetransmitNum;
      this.logWarning("Deprecated RTCDataChannelInit dictionary entry maxRetransmitNum used!", null, 0);
    }
    if (dict.outOfOrderAllowed != undefined) {
      dict.ordered = !dict.outOfOrderAllowed; // the meaning is swapped with
                                              // the name change
      this.logWarning("Deprecated RTCDataChannelInit dictionary entry outOfOrderAllowed used!", null, 0);
    }
    if (dict.preset != undefined) {
      dict.negotiated = dict.preset;
      this.logWarning("Deprecated RTCDataChannelInit dictionary entry preset used!", null, 0);
    }
    if (dict.stream != undefined) {
      dict.id = dict.stream;
      this.logWarning("Deprecated RTCDataChannelInit dictionary entry stream used!", null, 0);
    }

    if (dict.maxRetransmitTime != undefined &&
        dict.maxRetransmits != undefined) {
      throw new this._win.DOMError("InvalidParameterError",
          "Both maxRetransmitTime and maxRetransmits cannot be provided");
    }
    let protocol;
    if (dict.protocol == undefined) {
      protocol = "";
    } else {
      protocol = dict.protocol;
    }

    // Must determine the type where we still know if entries are undefined.
    let type;
    if (dict.maxRetransmitTime != undefined) {
      type = Ci.IPeerConnection.kDataChannelPartialReliableTimed;
    } else if (dict.maxRetransmits != undefined) {
      type = Ci.IPeerConnection.kDataChannelPartialReliableRexmit;
    } else {
      type = Ci.IPeerConnection.kDataChannelReliable;
    }

    // Synchronous since it doesn't block.
    let channel = this._impl.createDataChannel(
      label, protocol, type, !dict.ordered, dict.maxRetransmitTime,
      dict.maxRetransmits, dict.negotiated ? true : false,
      dict.id != undefined ? dict.id : 0xFFFF
    );
    return channel;
  }
};

// This is a separate object because we don't want to expose it to DOM.
function PeerConnectionObserver() {
  this._dompc = null;
}
PeerConnectionObserver.prototype = {
  classDescription: "PeerConnectionObserver",
  classID: PC_OBS_CID,
  contractID: PC_OBS_CONTRACT,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports,
                                         Ci.nsIDOMGlobalPropertyInitializer]),
  init: function(win) { this._win = win; },

  __init: function(dompc) {
    this._dompc = dompc._innerObject;
  },

  newError: function(code, message) {
    // These strings must match those defined in the WebRTC spec.
    const reasonName = [
      "",
      "InternalError",
      "InvalidCandidateError",
      "InvalidParameter",
      "InvalidStateError",
      "InvalidSessionDescriptionError",
      "IncompatibleSessionDescriptionError",
      "InternalError",
      "IncompatibleMediaStreamTrackError",
      "InternalError"
    ];
    let name = reasonName[Math.min(code, reasonName.length - 1)];
    return new this._dompc._win.DOMError(name, message);
  },

  dispatchEvent: function(event) {
    this._dompc.dispatchEvent(event);
  },

  onCreateOfferSuccess: function(sdp) {
    let pc = this._dompc;
    let fp = pc._impl.fingerprint;
    let origin = Cu.getWebIDLCallerPrincipal().origin;
    pc._localIdp.appendIdentityToSDP(sdp, fp, origin, function(sdp, assertion) {
      if (assertion) {
        pc._gotIdentityAssertion(assertion);
      }
      pc._onCreateOfferSuccess(new pc._win.mozRTCSessionDescription({ type: "offer",
                                                                      sdp: sdp }));
    }.bind(this));
  },

  onCreateOfferError: function(code, message) {
    this._dompc._onCreateOfferFailure(this.newError(code, message));
  },

  onCreateAnswerSuccess: function(sdp) {
    let pc = this._dompc;
    let fp = pc._impl.fingerprint;
    let origin = Cu.getWebIDLCallerPrincipal().origin;
    pc._localIdp.appendIdentityToSDP(sdp, fp, origin, function(sdp, assertion) {
      if (assertion) {
        pc._gotIdentityAssertion(assertion);
      }
      pc._onCreateAnswerSuccess(new pc._win.mozRTCSessionDescription({ type: "answer",
                                                                       sdp: sdp }));
    }.bind(this));
  },

  onCreateAnswerError: function(code, message) {
    this._dompc._onCreateAnswerFailure(this.newError(code, message));
  },

  onSetLocalDescriptionSuccess: function() {
    this._dompc._onSetLocalDescriptionSuccess();
  },

  onSetRemoteDescriptionSuccess: function() {
    this._dompc._onSetRemoteDescriptionSuccess();
  },

  onSetLocalDescriptionError: function(code, message) {
    this._localType = null;
    this._dompc._onSetLocalDescriptionFailure(this.newError(code, message));
  },

  onSetRemoteDescriptionError: function(code, message) {
    this._remoteType = null;
    this._dompc._onSetRemoteDescriptionFailure(this.newError(code, message));
  },

  onAddIceCandidateSuccess: function() {
    this._dompc._onAddIceCandidateSuccess();
  },

  onAddIceCandidateError: function(code, message) {
    this._dompc._onAddIceCandidateError(this.newError(code, message));
  },

  onIceCandidate: function(level, mid, candidate) {
    if (candidate == "") {
      this.foundIceCandidate(null);
    } else {
      this.foundIceCandidate(new this._dompc._win.mozRTCIceCandidate(
          {
              candidate: candidate,
              sdpMid: mid,
              sdpMLineIndex: level
          }
      ));
    }
  },


  // This method is primarily responsible for updating iceConnectionState.
  // This state is defined in the WebRTC specification as follows:
  //
  // iceConnectionState:
  // -------------------
  //   new           The ICE Agent is gathering addresses and/or waiting for
  //                 remote candidates to be supplied.
  //
  //   checking      The ICE Agent has received remote candidates on at least
  //                 one component, and is checking candidate pairs but has not
  //                 yet found a connection. In addition to checking, it may
  //                 also still be gathering.
  //
  //   connected     The ICE Agent has found a usable connection for all
  //                 components but is still checking other candidate pairs to
  //                 see if there is a better connection. It may also still be
  //                 gathering.
  //
  //   completed     The ICE Agent has finished gathering and checking and found
  //                 a connection for all components. Open issue: it is not
  //                 clear how the non controlling ICE side knows it is in the
  //                 state.
  //
  //   failed        The ICE Agent is finished checking all candidate pairs and
  //                 failed to find a connection for at least one component.
  //                 Connections may have been found for some components.
  //
  //   disconnected  Liveness checks have failed for one or more components.
  //                 This is more aggressive than failed, and may trigger
  //                 intermittently (and resolve itself without action) on a
  //                 flaky network.
  //
  //   closed        The ICE Agent has shut down and is no longer responding to
  //                 STUN requests.

  handleIceConnectionStateChange: function(iceConnectionState) {
    var histogram = Services.telemetry.getHistogramById("WEBRTC_ICE_SUCCESS_RATE");

    if (iceConnectionState === 'failed') {
      histogram.add(false);
      this._dompc.logError("ICE failed, see about:webrtc for more details", null, 0);
    }
    if (this._dompc.iceConnectionState === 'checking' &&
        (iceConnectionState === 'completed' ||
         iceConnectionState === 'connected')) {
          histogram.add(true);
    }
    this._dompc.changeIceConnectionState(iceConnectionState);
  },

  // This method is responsible for updating iceGatheringState. This
  // state is defined in the WebRTC specification as follows:
  //
  // iceGatheringState:
  // ------------------
  //   new        The object was just created, and no networking has occurred
  //              yet.
  //
  //   gathering  The ICE engine is in the process of gathering candidates for
  //              this RTCPeerConnection.
  //
  //   complete   The ICE engine has completed gathering. Events such as adding
  //              a new interface or a new TURN server will cause the state to
  //              go back to gathering.
  //
  handleIceGatheringStateChange: function(gatheringState) {
    this._dompc.changeIceGatheringState(gatheringState);
  },

  onStateChange: function(state) {
    switch (state) {
      case "SignalingState":
        this.dispatchEvent(new this._win.Event("signalingstatechange"));
        break;

      case "IceConnectionState":
        this.handleIceConnectionStateChange(this._dompc._pc.iceConnectionState);
        break;

      case "IceGatheringState":
        this.handleIceGatheringStateChange(this._dompc._pc.iceGatheringState);
        break;

      case "SdpState":
        // No-op
        break;

      case "ReadyState":
        // No-op
        break;

      case "SipccState":
        // No-op
        break;

      default:
        this._dompc.logWarning("Unhandled state type: " + state, null, 0);
        break;
    }
  },

  onGetStatsSuccess: function(dict) {
    let chromeobj = new RTCStatsReport(this._dompc._win, dict);
    let webidlobj = this._dompc._win.RTCStatsReport._create(this._dompc._win,
                                                            chromeobj);
    chromeobj.makeStatsPublic();
    this._dompc._onGetStatsSuccess(webidlobj);
  },

  onGetStatsError: function(code, message) {
    this._dompc._onGetStatsFailure(this.newError(code, message));
  },

  onAddStream: function(stream) {
    let ev = new this._dompc._win.MediaStreamEvent("addstream",
                                                   { stream: stream });
    this.dispatchEvent(ev);
  },

  onRemoveStream: function(stream, type) {
    this.dispatchEvent(new this._dompc._win.MediaStreamEvent("removestream",
                                                             { stream: stream }));
  },

  onAddTrack: function(track) {
    let ev = new this._dompc._win.MediaStreamTrackEvent("addtrack",
                                                        { track: track });
    this.dispatchEvent(ev);
  },

  onRemoveTrack: function(track, type) {
    this.dispatchEvent(new this._dompc._win.MediaStreamTrackEvent("removetrack",
                                                                  { track: track }));
  },

  onReplaceTrackSuccess: function() {
    var pc = this._dompc;
    pc._onReplaceTrackSender.track = pc._onReplaceTrackWithTrack;
    pc._onReplaceTrackWithTrack = null;
    pc._onReplaceTrackSender = null;
    pc._onReplaceTrackSuccess();
  },

  onReplaceTrackError: function(code, message) {
    var pc = this._dompc;
    pc._onReplaceTrackWithTrack = null;
    pc._onReplaceTrackSender = null;
    pc._onReplaceTrackError(this.newError(code, message));
  },

  foundIceCandidate: function(cand) {
    this.dispatchEvent(new this._dompc._win.RTCPeerConnectionIceEvent("icecandidate",
                                                                      { candidate: cand } ));
  },

  notifyDataChannel: function(channel) {
    this.dispatchEvent(new this._dompc._win.RTCDataChannelEvent("datachannel",
                                                                { channel: channel }));
  }
};

function RTCPeerConnectionStatic() {
}
RTCPeerConnectionStatic.prototype = {
  classDescription: "mozRTCPeerConnectionStatic",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports,
                                         Ci.nsIDOMGlobalPropertyInitializer]),

  classID: PC_STATIC_CID,
  contractID: PC_STATIC_CONTRACT,

  init: function(win) {
    this._winID = win.QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIDOMWindowUtils).currentInnerWindowID;
  },

  registerPeerConnectionLifecycleCallback: function(cb) {
    _globalPCList._registerPeerConnectionLifecycleCallback(this._winID, cb);
  },
};

function RTCRtpSender(pc, track, stream) {
  this._pc = pc;
  this.track = track;
  this._stream = stream;
}
RTCRtpSender.prototype = {
  classDescription: "RTCRtpSender",
  classID: PC_SENDER_CID,
  contractID: PC_SENDER_CONTRACT,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports]),

  replaceTrack: function(withTrack) {
    return this._pc._queue(() => this._pc._replaceTrack(this, withTrack));
  }
};

function RTCRtpReceiver(pc, track) {
  this.pc = pc;
  this.track = track;
}
RTCRtpReceiver.prototype = {
  classDescription: "RTCRtpReceiver",
  classID: PC_RECEIVER_CID,
  contractID: PC_RECEIVER_CONTRACT,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports]),
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory(
  [GlobalPCList,
   RTCIceCandidate,
   RTCSessionDescription,
   RTCPeerConnection,
   RTCPeerConnectionStatic,
   RTCRtpReceiver,
   RTCRtpSender,
   RTCStatsReport,
   RTCIdentityAssertion,
   PeerConnectionObserver]
);