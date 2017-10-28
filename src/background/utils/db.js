import { i18n, request, buffer2string, getFullUrl } from 'src/common';
import { objectGet, objectSet } from 'src/common/object';
import { getNameURI, isRemote, parseMeta, newScript } from './script';
import { testScript, testBlacklist } from './tester';
import { register } from './init';
import patchDB from './patch-db';

function cacheOrFetch(handle) {
  const requests = {};
  return function cachedHandle(url, ...args) {
    let promise = requests[url];
    if (!promise) {
      promise = handle.call(this, url, ...args)
      .catch(() => {
        console.error(`Error fetching: ${url}`);
      })
      .then(() => {
        delete requests[url];
      });
      requests[url] = promise;
    }
    return promise;
  };
}
function ensureListArgs(handle) {
  return function handleList(data) {
    let items = Array.isArray(data) ? data : [data];
    items = items.filter(Boolean);
    if (!items.length) return Promise.resolve();
    return handle.call(this, items);
  };
}

const store = {};
const storage = {
  base: {
    prefix: '',
    getKey(id) {
      return `${this.prefix}${id}`;
    },
    getOne(id) {
      const key = this.getKey(id);
      return browser.storage.local.get(key).then(data => data[key]);
    },
    getMulti(ids, def) {
      return browser.storage.local.get(ids.map(id => this.getKey(id)))
      .then(data => {
        const result = {};
        ids.forEach(id => { result[id] = data[this.getKey(id)] || def; });
        return result;
      });
    },
    set(id, value) {
      if (!id) return Promise.resolve();
      return browser.storage.local.set({
        [this.getKey(id)]: value,
      });
    },
    remove(id) {
      if (!id) return Promise.resolve();
      return browser.storage.local.remove(this.getKey(id));
    },
    removeMulti(ids) {
      return browser.storage.local.remove(ids.map(id => this.getKey(id)));
    },
  },
};
storage.script = Object.assign({}, storage.base, {
  prefix: 'scr:',
  dump: ensureListArgs(function dump(items) {
    const updates = {};
    items.forEach(item => {
      updates[this.getKey(item.props.id)] = item;
      store.scriptMap[item.props.id] = item;
    });
    return browser.storage.local.set(updates)
    .then(() => items);
  }),
});
storage.code = Object.assign({}, storage.base, {
  prefix: 'code:',
});
storage.value = Object.assign({}, storage.base, {
  prefix: 'val:',
  dump(dict) {
    const updates = {};
    Object.keys(dict)
    .forEach(id => {
      const value = dict[id];
      updates[this.getKey(id)] = value;
    });
    return browser.storage.local.set(updates);
  },
});
storage.require = Object.assign({}, storage.base, {
  prefix: 'req:',
  fetch: cacheOrFetch(function fetch(uri) {
    return request(uri).then(({ data }) => this.set(uri, data));
  }),
});
storage.cache = Object.assign({}, storage.base, {
  prefix: 'cac:',
  fetch: cacheOrFetch(function fetch(uri, check) {
    return request(uri, { responseType: 'arraybuffer' })
    .then(({ data: buffer }) => {
      const data = {
        buffer,
        blob: options => new Blob([buffer], options),
        string: () => buffer2string(buffer),
        base64: () => window.btoa(data.string()),
      };
      return (check ? Promise.resolve(check(data)) : Promise.resolve())
      .then(() => this.set(uri, data.base64()));
    });
  }),
});

register(initialize());

function initialize() {
  return browser.storage.local.get('version')
  .then(({ version: lastVersion }) => {
    const { version } = browser.runtime.getManifest();
    return (lastVersion ? Promise.resolve() : patchDB())
    .then(() => {
      if (version !== lastVersion) return browser.storage.local.set({ version });
    });
  })
  .then(() => browser.storage.local.get())
  .then(data => {
    const scripts = [];
    const storeInfo = {
      id: 0,
      position: 0,
    };
    Object.keys(data).forEach(key => {
      const value = data[key];
      if (key.startsWith('scr:')) {
        // {
        //   meta,
        //   custom,
        //   props: { id, position, uri },
        //   config: { enabled, shouldUpdate },
        // }
        scripts.push(value);
        storeInfo.id = Math.max(storeInfo.id, getInt(objectGet(value, 'props.id')));
        storeInfo.position = Math.max(storeInfo.position, getInt(objectGet(value, 'props.position')));
      }
    });
    scripts.sort((a, b) => {
      const [pos1, pos2] = [a, b].map(item => getInt(objectGet(item, 'props.position')));
      return Math.sign(pos1 - pos2);
    });
    Object.assign(store, {
      scripts,
      storeInfo,
      scriptMap: scripts.reduce((map, item) => {
        map[item.props.id] = item;
        return map;
      }, {}),
    });
    if (process.env.DEBUG) {
      console.log('store:', store); // eslint-disable-line no-console
    }
    return normalizePosition();
  });
}

function getInt(val) {
  return +val || 0;
}

export function normalizePosition() {
  const updates = [];
  store.scripts.forEach((item, index) => {
    const position = index + 1;
    if (objectGet(item, 'props.position') !== position) {
      objectSet(item, 'props.position', position);
      updates.push(item);
    }
    // XXX patch v2.8.0
    if (typeof item.custom.origInclude === 'undefined') {
      item.custom = Object.assign({
        origInclude: true,
        origExclude: true,
        origMatch: true,
        origExcludeMatch: true,
      }, item.custom);
      if (!updates.includes(item)) updates.push(item);
    }
  });
  store.storeInfo.position = store.scripts.length;
  const { length } = updates;
  return length ? storage.script.dump(updates).then(() => length) : Promise.resolve();
}

export function getScript(where) {
  let script;
  if (where.id) {
    script = store.scriptMap[where.id];
  } else {
    const uri = where.uri || getNameURI({ meta: where.meta, id: '@@should-have-name' });
    const predicate = item => uri === objectGet(item, 'props.uri');
    script = store.scripts.find(predicate);
  }
  return Promise.resolve(script);
}

export function getScripts() {
  return Promise.resolve(store.scripts);
}

export function getScriptByIds(ids) {
  return Promise.all(ids.map(id => getScript({ id })))
  .then(scripts => scripts.filter(Boolean));
}

export function getScriptCode(id) {
  return storage.code.getOne(id);
}

/**
 * @desc Load values for batch updates.
 * @param {Array} ids
 */
export function getValueStoresByIds(ids) {
  return storage.value.getMulti(ids);
}

/**
 * @desc Dump values for batch updates.
 * @param {Object} valueDict { id1: value1, id2: value2, ... }
 */
export function dumpValueStores(valueDict) {
  if (process.env.DEBUG) {
    console.info('Update value stores', valueDict);
  }
  return storage.value.dump(valueDict).then(() => valueDict);
}

export function dumpValueStore(where, valueStore) {
  return (where.id
    ? Promise.resolve(where.id)
    : getScript(where).then(script => objectGet(script, 'props.id')))
  .then(id => {
    if (id) return dumpValueStores({ [id]: valueStore });
  });
}

/**
 * @desc Get scripts to be injected to page with specific URL.
 */
export function getScriptsByURL(url) {
  const scripts = testBlacklist(url)
    ? []
    : store.scripts.filter(script => !script.config.removed && testScript(url, script));
  const reqKeys = {};
  const cacheKeys = {};
  scripts.forEach(script => {
    if (script.config.enabled) {
      if (!script.custom.pathMap) buildPathMap(script);
      const { pathMap } = script.custom;
      script.meta.require.forEach(key => {
        reqKeys[pathMap[key] || key] = 1;
      });
      Object.values(script.meta.resources).forEach(key => {
        cacheKeys[pathMap[key] || key] = 1;
      });
    }
  });
  const enabledScripts = scripts
  .filter(script => script.config.enabled);
  const gmValues = {
    GM_getValue: 1,
    GM_setValue: 1,
    GM_listValues: 1,
    GM_deleteValue: 1,
  };
  const scriptsWithValue = enabledScripts
  .filter(script => {
    const grant = objectGet(script, 'meta.grant');
    return grant && grant.some(gm => gmValues[gm]);
  });
  return Promise.all([
    storage.require.getMulti(Object.keys(reqKeys)),
    storage.cache.getMulti(Object.keys(cacheKeys)),
    storage.value.getMulti(scriptsWithValue.map(script => script.props.id), {}),
    storage.code.getMulti(enabledScripts.map(script => script.props.id)),
  ])
  .then(([require, cache, values, code]) => ({
    scripts,
    require,
    cache,
    values,
    code,
  }));
}

/**
 * @desc Get data for dashboard.
 */
export function getData() {
  const cacheKeys = {};
  const { scripts } = store;
  scripts.forEach(script => {
    const icon = objectGet(script, 'meta.icon');
    if (isRemote(icon)) cacheKeys[icon] = 1;
  });
  return storage.cache.getMulti(Object.keys(cacheKeys))
  .then(cache => {
    Object.keys(cache).forEach(key => {
      cache[key] = `data:image/png;base64,${cache[key]}`;
    });
    return cache;
  })
  .then(cache => ({ scripts, cache }));
}

export function checkRemove() {
  const toRemove = store.scripts.filter(script => script.config.removed);
  if (toRemove.length) {
    store.scripts = store.scripts.filter(script => !script.config.removed);
    const ids = toRemove.map(script => script.props.id);
    storage.script.removeMulti(ids);
    storage.code.removeMulti(ids);
    storage.value.removeMulti(ids);
  }
  return Promise.resolve(toRemove.length);
}

export function removeScript(id) {
  const i = store.scripts.findIndex(item => id === objectGet(item, 'props.id'));
  if (i >= 0) {
    store.scripts.splice(i, 1);
    storage.script.remove(id);
    storage.code.remove(id);
    storage.value.remove(id);
  }
  return browser.runtime.sendMessage({
    cmd: 'RemoveScript',
    data: id,
  });
}

export function moveScript(id, offset) {
  const index = store.scripts.findIndex(item => id === objectGet(item, 'props.id'));
  const step = offset > 0 ? 1 : -1;
  const indexStart = index;
  const indexEnd = index + offset;
  const offsetI = Math.min(indexStart, indexEnd);
  const offsetJ = Math.max(indexStart, indexEnd);
  const updated = store.scripts.slice(offsetI, offsetJ + 1);
  if (step > 0) {
    updated.push(updated.shift());
  } else {
    updated.unshift(updated.pop());
  }
  store.scripts = [
    ...store.scripts.slice(0, offsetI),
    ...updated,
    ...store.scripts.slice(offsetJ + 1),
  ];
  return normalizePosition();
}

function saveScript(script, code) {
  const config = script.config || {};
  config.enabled = getInt(config.enabled);
  config.shouldUpdate = getInt(config.shouldUpdate);
  const props = script.props || {};
  let oldScript;
  if (!props.id) {
    store.storeInfo.id += 1;
    props.id = store.storeInfo.id;
  } else {
    oldScript = store.scriptMap[props.id];
  }
  props.uri = getNameURI(script);
  // Do not allow script with same name and namespace
  if (store.scripts.some(item => {
    const itemProps = item.props || {};
    return props.id !== itemProps.id && props.uri === itemProps.uri;
  })) {
    throw i18n('msgNamespaceConflict');
  }
  if (oldScript) {
    script.config = Object.assign({}, oldScript.config, config);
    script.props = Object.assign({}, oldScript.props, props);
    const index = store.scripts.indexOf(oldScript);
    store.scripts[index] = script;
  } else {
    store.storeInfo.position += 1;
    props.position = store.storeInfo.position;
    script.config = config;
    script.props = props;
    store.scripts.push(script);
  }
  return Promise.all([
    storage.script.dump(script),
    storage.code.set(props.id, code),
  ]);
}

export function updateScriptInfo(id, data) {
  const script = store.scriptMap[id];
  if (!script) return Promise.reject();
  script.config = Object.assign({}, script.config, data.config);
  script.custom = Object.assign({}, script.custom, data.custom);
  return storage.script.dump(script);
}

export function getExportData(ids, withValues) {
  const availableIds = ids.filter(id => {
    const script = store.scriptMap[id];
    return script && !script.config.removed;
  });
  return Promise.all([
    Promise.all(availableIds.map(id => getScript({ id }))),
    storage.code.getMulti(availableIds),
  ])
  .then(([scripts, codeMap]) => {
    const data = {};
    data.items = scripts.map(script => ({ script, code: codeMap[script.props.id] }));
    if (withValues) {
      return storage.value.getMulti(ids)
      .then(values => {
        data.values = values;
        return data;
      });
    }
    return data;
  });
}

export function parseScript(data) {
  const {
    id, code, message, isNew, config, custom,
  } = data;
  const meta = parseMeta(code);
  if (!meta.name) return Promise.reject(i18n('msgInvalidScript'));
  const result = {
    cmd: 'UpdateScript',
    data: {
      update: {
        message: message == null ? i18n('msgUpdated') : message || '',
      },
    },
  };
  return getScript({ id, meta })
  .then(oldScript => {
    let script;
    if (oldScript) {
      if (isNew) throw i18n('msgNamespaceConflict');
      script = Object.assign({}, oldScript);
    } else {
      ({ script } = newScript());
      result.cmd = 'AddScript';
      result.data.update.message = i18n('msgInstalled');
    }
    script.config = Object.assign({}, script.config, config, {
      removed: 0, // force reset `removed` since this is an installation
    });
    script.custom = Object.assign({}, script.custom, custom);
    script.meta = meta;
    if (!meta.homepageURL && !script.custom.homepageURL && isRemote(data.from)) {
      script.custom.homepageURL = data.from;
    }
    if (isRemote(data.url)) script.custom.lastInstallURL = data.url;
    objectSet(script, 'props.lastModified', data.modified || Date.now());
    const position = +data.position;
    if (position) objectSet(script, 'props.position', position);
    buildPathMap(script);
    return saveScript(script, code).then(() => script);
  })
  .then(script => {
    fetchScriptResources(script, data);
    Object.assign(result.data.update, script);
    result.data.where = { id: script.props.id };
    return result;
  });
}

function buildPathMap(script) {
  const { meta } = script;
  const base = script.custom.lastInstallURL;
  const pathMap = {};
  [
    ...meta.require,
    ...Object.values(meta.resources),
    isRemote(meta.icon) && meta.icon,
  ].forEach(key => {
    if (key) {
      const fullUrl = getFullUrl(key, base);
      if (fullUrl !== key) pathMap[key] = fullUrl;
    }
  });
  script.custom.pathMap = pathMap;
  return pathMap;
}

function fetchScriptResources(script, cache) {
  const { meta, custom: { pathMap } } = script;
  // @require
  meta.require.forEach(key => {
    const fullUrl = pathMap[key] || key;
    const cached = objectGet(cache, ['require', fullUrl]);
    if (cached) {
      storage.require.set(fullUrl, cached);
    } else {
      storage.require.fetch(fullUrl);
    }
  });
  // @resource
  Object.values(meta.resources).forEach(url => {
    const fullUrl = pathMap[url] || url;
    const cached = objectGet(cache, ['resources', fullUrl]);
    if (cached) {
      storage.cache.set(fullUrl, cached);
    } else {
      storage.cache.fetch(fullUrl);
    }
  });
  // @icon
  if (isRemote(meta.icon)) {
    const fullUrl = pathMap[meta.icon] || meta.icon;
    storage.cache.fetch(fullUrl, ({ blob: getBlob }) => new Promise((resolve, reject) => {
      const blob = getBlob({ type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const image = new Image();
      const free = () => URL.revokeObjectURL(url);
      image.onload = () => {
        free();
        resolve();
      };
      image.onerror = () => {
        free();
        reject();
      };
      image.src = url;
    }));
  }
}

export function vacuum() {
  const valueKeys = {};
  const cacheKeys = {};
  const requireKeys = {};
  const codeKeys = {};
  const mappings = [
    [storage.value, valueKeys],
    [storage.cache, cacheKeys],
    [storage.require, requireKeys],
    [storage.code, codeKeys],
  ];
  browser.storage.get().then(data => {
    Object.keys(data).forEach(key => {
      mappings.some(([substore, map]) => {
        const { prefix } = substore;
        if (key.startsWith(prefix)) {
          // -1 for untouched, 1 for touched, 2 for missing
          map[key.slice(prefix.length)] = -1;
          return true;
        }
        return false;
      });
    });
  });
  const touch = (obj, key) => {
    if (obj[key] < 0) obj[key] = 1;
    else if (!obj[key]) obj[key] = 2;
  };
  store.scripts.forEach(script => {
    const { id } = script.props;
    touch(codeKeys, id);
    touch(valueKeys, id);
    if (!script.custom.pathMap) buildPathMap(script);
    const { pathMap } = script.custom;
    script.meta.require.forEach(url => {
      touch(requireKeys, pathMap[url] || url);
    });
    Object.values(script.meta.resources).forEach(url => {
      touch(cacheKeys, pathMap[url] || url);
    });
    const { icon } = script.meta;
    if (isRemote(icon)) {
      const fullUrl = pathMap[icon] || icon;
      touch(cacheKeys, fullUrl);
    }
  });
  mappings.forEach(([substore, map]) => {
    Object.keys(map).forEach(key => {
      const value = map[key];
      if (value < 0) {
        // redundant value
        substore.remove(key);
      } else if (value === 2 && substore.fetch) {
        // missing resource
        substore.fetch(key);
      }
    });
  });
}
