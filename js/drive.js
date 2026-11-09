(function () {
  'use strict';

  const API = 'https://www.googleapis.com/drive/v3/';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FIELDS = 'id,name,version,modifiedTime';
  const APP = 'jornada-laboral';
  const FOLDER_NAME = 'JornadaTuvisa';
  const RECOVERY_FOLDER_NAME = 'Recuperaciones';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  let session = null;
  let generation = 0;
  let authorization = null;
  let mutating = false;
  const creations = new Map();
  const writes = new Map();
  const requests = new Set();
  const folderIds = new Map();

  function failure(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function ready() {
    return typeof window.google?.accounts?.oauth2?.initTokenClient === 'function';
  }

  function connected() {
    return !!(session?.account && session.expires > Date.now());
  }

  function check(ctx) {
    if (!ctx || ctx !== session || ctx.generation !== generation || ctx.expires <= Date.now()) {
      throw failure('auth', 'La sesión de Google ha caducado o ha cambiado. Vuelve a conectar; tus cambios siguen pendientes.');
    }
  }

  function current() {
    check(session);
    if (!session.account) throw failure('auth', 'Termina de conectar con Google Drive antes de continuar.');
    return session;
  }

  function disconnect() {
    generation++;
    session = null;
    creations.clear();
    writes.clear();
    folderIds.clear();
    requests.forEach(controller => controller.abort());
    requests.clear();
    if (authorization) authorization.cancel();
  }

  function connect(options = {}) {
    if (authorization) return authorization.promise;
    if (!ready()) return Promise.reject(failure('unavailable', 'La biblioteca de Google no está disponible. Comprueba la conexión y vuelve a intentarlo.'));
    if (mutating) return Promise.reject(failure('busy', 'Espera a que termine la operación de Drive antes de cambiar de cuenta.'));
    const clientId = window.JornadaDriveConfig?.clientId;
    if (!clientId) return Promise.reject(failure('configuration', 'Falta el identificador público del cliente de Google.'));
    session = null;
    const attempt = ++generation;
    let resolveAttempt;
    let rejectAttempt;
    const promise = new Promise((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const pending = {
      promise,
      cancel: () => finish(failure('auth', 'Se ha cancelado la conexión con Google Drive.'))
    };
    authorization = pending;
    function finish(error, account) {
      if (authorization !== pending) return;
      clearTimeout(timer);
      authorization = null;
      if (error) {
        if (generation === attempt) session = null;
        rejectAttempt(error);
      } else {
        resolveAttempt(account);
      }
    }
    const timer = setTimeout(() => finish(failure('auth', 'La autorización de Google ha tardado demasiado. Vuelve a pulsar Conectar.')), 120000);
    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        include_granted_scopes: false,
        callback: async response => {
          if (authorization !== pending || generation !== attempt) return;
          if (response.error) {
            finish(failure('auth', response.error === 'access_denied'
              ? 'No has concedido acceso al archivo de Drive. Tus cambios no se han enviado.'
              : 'Google no ha autorizado la conexión. Vuelve a intentarlo.'));
            return;
          }
          const lifetime = Number(response.expires_in);
          if (!response.access_token || !Number.isFinite(lifetime) || lifetime <= 0 ||
              !String(response.scope || '').split(/\s+/).includes(SCOPE)) {
            finish(failure('auth', 'Google no ha concedido el permiso necesario para los archivos de esta aplicación.'));
            return;
          }
          const ctx = {
            token: response.access_token,
            expires: Date.now() + Math.max(0, lifetime * 1000 - 10000),
            generation: attempt,
            account: null
          };
          session = ctx;
          try {
            const about = await json(ctx, 'about', { fields: 'user(permissionId)' });
            if (!about.user?.permissionId) throw failure('auth', 'Drive no ha permitido identificar la cuenta. No se abrirá ningún archivo.');
            ctx.account = { id: String(about.user.permissionId) };
            finish(null, { ...ctx.account });
          } catch (error) {
            finish(error);
          }
        },
        error_callback: error => {
          const messages = {
            popup_closed: 'Has cerrado la ventana de Google sin conectar. Tus cambios siguen pendientes.',
            popup_failed_to_open: 'El navegador ha bloqueado la ventana de Google. Permite ventanas emergentes y pulsa Conectar.'
          };
          finish(failure('auth', messages[error.type] || 'No se ha podido abrir la autorización de Google. Vuelve a pulsar Conectar.'));
        }
      });
      // Must remain synchronous with the user's click: do not await before opening GIS.
      client.requestAccessToken({ prompt: options.selectAccount ? 'select_account' : '' });
    } catch (error) {
      finish(failure('auth', 'No se ha podido iniciar la autorización de Google.', error));
    }
    return promise;
  }

  async function request(ctx, path, params = {}, options = {}, upload = false) {
    check(ctx);
    const url = new URL(path, upload ? UPLOAD : API);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) url.searchParams.set(key, String(value));
    });
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url.href, {
        ...options,
        headers: { ...options.headers, Authorization: 'Bearer ' + ctx.token },
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
      check(ctx);
      if (!response.ok) {
        let detail;
        try {
          detail = await response.json();
        } catch (error) {
          // A proxy can return HTML rather than the documented Drive error body.
          detail = null;
        }
        check(ctx);
        const reasons = (detail?.error?.errors || []).map(item => item.reason);
        let code = 'remote';
        let message = 'Google Drive no ha completado la operación. Conserva tus cambios y vuelve a comprobar el archivo.';
        if (response.status === 401) {
          ctx.expires = 0;
          code = 'auth';
          message = 'Google ha caducado o rechazado la sesión. Vuelve a conectar; tus cambios siguen pendientes.';
        } else if (response.status === 404) {
          code = 'missing';
          message = 'El archivo no existe o esta cuenta ya no puede acceder a él. No se han descartado tus cambios.';
        } else if (response.status === 409 || response.status === 412) {
          code = 'conflict';
          message = 'El archivo ha cambiado en Drive. Revisa la versión remota antes de guardar.';
        } else if (response.status === 429 || reasons.some(reason => /rateLimit|quota|storageQuota/i.test(reason))) {
          code = 'quota';
          message = 'Drive ha alcanzado un límite de peticiones o almacenamiento. Espera o revisa tu cuota; tus cambios siguen pendientes.';
        } else if (response.status === 403) {
          code = 'permission';
          message = 'Google ha denegado el acceso. Comprueba la cuenta, los permisos y que Drive API esté habilitada.';
        }
        const error = failure(code, message);
        error.status = response.status;
        throw error;
      }
      // Consume the body within the timeout, also covering interrupted downloads.
      const text = await response.text();
      check(ctx);
      return { text, etag: response.headers.get('ETag') || undefined };
    } catch (error) {
      if (typeof error.code === 'string') throw error;
      check(ctx);
      throw failure('network', 'No se ha podido confirmar la respuesta de Drive. Comprueba la conexión; no repitas el guardado sin revisar el archivo.', error);
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
    }
  }

  async function json(ctx, path, params, options, upload) {
    const result = await request(ctx, path, params, options, upload);
    try {
      return JSON.parse(result.text);
    } catch (error) {
      throw failure('response', 'Drive ha devuelto una respuesta incompleta o no válida. No se ha confirmado la operación.', error);
    }
  }

  function fileMetadata(file) {
    if (file?.trashed) throw failure('missing', 'El archivo está en la papelera de Drive. Conserva tus cambios y restaura el archivo.');
    if (!file?.id || typeof file.name !== 'string' || typeof file.version !== 'string' || !file.modifiedTime) {
      throw failure('response', 'Drive no ha devuelto una versión válida del archivo.');
    }
    const result = { id: file.id, name: file.name, version: file.version, modifiedTime: file.modifiedTime };
    if (Array.isArray(file.parents)) result.parents = file.parents;
    if (typeof file.mimeType === 'string') result.mimeType = file.mimeType;
    if (file.appProperties && typeof file.appProperties === 'object') result.appProperties = file.appProperties;
    return result;
  }

  function filePath(id) {
    if (typeof id !== 'string' || !id) throw failure('invalid', 'No se ha indicado un archivo válido de Drive.');
    return 'files/' + encodeURIComponent(id);
  }

  async function getMetadata(ctx, id) {
    return fileMetadata(await json(ctx, filePath(id), { fields: FIELDS + ',trashed,parents,mimeType' }));
  }

  async function snapshot(ctx, id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await getMetadata(ctx, id);
      const content = await request(ctx, filePath(id), { alt: 'media' });
      const after = await getMetadata(ctx, id);
      if (before.version === after.version) {
        const result = { file: after, text: content.text };
        if (content.etag) result.etag = content.etag;
        return result;
      }
    }
    throw failure('conflict', 'El archivo ha cambiado durante la lectura. Vuelve a cargarlo; tus cambios locales siguen pendientes.');
  }

  async function listFiles(ctx, query) {
    const files = [];
    let pageToken;
    const seen = new Set();
    do {
      const result = await json(ctx, 'files', {
        q: query,
        spaces: 'drive',
        fields: 'nextPageToken,incompleteSearch,files(' + FIELDS + ',parents,mimeType,appProperties)',
        pageSize: 100,
        pageToken
      });
      if (!Array.isArray(result.files) || result.incompleteSearch) {
        throw failure('response', 'Drive no ha completado la búsqueda. No crees un archivo nuevo hasta poder comprobar los existentes.');
      }
      files.push(...result.files.map(fileMetadata));
      pageToken = result.nextPageToken;
      if (pageToken && seen.has(pageToken)) throw failure('response', 'Drive ha devuelto una paginación repetida. No se puede confirmar la lista de archivos.');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return files;
  }

  async function ensureFolder(ctx) {
    const accountId = ctx.account.id;
    const cacheKey = accountId + ':main';
    const cachedId = folderIds.get(cacheKey);
    if (cachedId) {
      try {
        const cached = await getMetadata(ctx, cachedId);
        if (cached.name !== FOLDER_NAME || cached.mimeType !== FOLDER_MIME) {
          throw failure('response', 'La carpeta de jornada guardada en esta sesión no es válida.');
        }
        return cached
      } catch (error) {
        if (error.code !== 'missing') throw error;
        folderIds.delete(cacheKey)
      }
    }
    const query = "trashed = false and mimeType = '" + FOLDER_MIME +
      "' and appProperties has { key='app' and value='" + APP +
      "' } and appProperties has { key='role' and value='folder' }";
    let folders = await listFiles(ctx, query);
    if (folders.length > 1) {
      throw failure('conflict', 'Hay varias carpetas de jornada creadas por esta aplicación. No se moverán archivos automáticamente; revisa tu Drive antes de continuar.');
    }
    if (!folders.length) {
      folders = [await create(ctx, 'folder', 'folder', '{}', FOLDER_NAME, {}, null, FOLDER_MIME)]
    }
    const folder = folders[0];
    if (folder.name !== FOLDER_NAME || folder.mimeType !== FOLDER_MIME) {
      throw failure('response', 'La carpeta de jornada de Drive no tiene el nombre o tipo esperado.');
    }
    folderIds.set(cacheKey, folder.id);
    const appFiles = await listFiles(ctx, "trashed = false and appProperties has { key='app' and value='" + APP + "' }");
    for (const file of appFiles) {
      if (file.id === folder.id || file.mimeType === FOLDER_MIME ||
          (file.parents && file.parents.includes(folder.id))) continue;
      const removeParents = (file.parents || []).filter(parent => parent !== folder.id).join(',');
      const params = { addParents: folder.id, fields: FIELDS + ',parents,mimeType' };
      if (removeParents) params.removeParents = removeParents;
      await json(ctx, filePath(file.id), params, { method: 'PATCH' });
    }
    return folder;
  }

  async function ensureRecoveryFolder(ctx) {
    const accountId = ctx.account.id;
    const cacheKey = accountId + ':recovery';
    const cachedId = folderIds.get(cacheKey);
    if (cachedId) {
      try {
        const cached = await getMetadata(ctx, cachedId);
        if (cached.name !== RECOVERY_FOLDER_NAME || cached.mimeType !== FOLDER_MIME) {
          throw failure('response', 'La carpeta de recuperaciones guardada en esta sesión no es válida.');
        }
        return cached
      } catch (error) {
        if (error.code !== 'missing') throw error;
        folderIds.delete(cacheKey)
      }
    }
    const query = "trashed = false and mimeType = '" + FOLDER_MIME +
      "' and appProperties has { key='app' and value='" + APP +
      "' } and appProperties has { key='role' and value='recovery-folder' }";
    let folders = await listFiles(ctx, query);
    if (folders.length > 1) {
      throw failure('conflict', 'Hay varias carpetas de recuperaciones creadas por esta aplicación. No se moverán archivos automáticamente.');
    }
    if (!folders.length) {
      folders = [await create(ctx, 'recovery-folder', 'recovery-folder', '{}',
        RECOVERY_FOLDER_NAME, {}, null, FOLDER_MIME)]
    }
    const folder = folders[0];
    if (folder.name !== RECOVERY_FOLDER_NAME || folder.mimeType !== FOLDER_MIME) {
      throw failure('response', 'La carpeta de recuperaciones de Drive no tiene el nombre o tipo esperado.');
    }
    folderIds.set(cacheKey, folder.id);
    const recoveryFiles = await listFiles(ctx, "trashed = false and appProperties has { key='app' and value='" +
      APP + "' } and appProperties has { key='role' and value='recovery' }");
    for (const file of recoveryFiles) {
      if (file.parents && file.parents.includes(folder.id)) continue;
      const removeParents = (file.parents || []).filter(parent => parent !== folder.id).join(',');
      const params = { addParents: folder.id, fields: FIELDS + ',parents,mimeType,appProperties' };
      if (removeParents) params.removeParents = removeParents;
      await json(ctx, filePath(file.id), params, { method: 'PATCH' });
    }
    return folder;
  }

  function recoveryQuery(id) {
    return "trashed = false and appProperties has { key='app' and value='" + APP +
      "' } and appProperties has { key='role' and value='recovery' } and appProperties has { key='sourceId' and value='" +
      id + "' }";
  }

  async function pruneRecoveries(ctx, sourceId, keepId) {
    let files = await listFiles(ctx, recoveryQuery(sourceId));
    if (!files.length) return;
    await ensureRecoveryFolder(ctx);
    files = await listFiles(ctx, recoveryQuery(sourceId));
    if (!keepId && files.length) {
      files.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
      keepId = files[0].id;
    }
    for (const file of files) {
      if (file.id === keepId) continue;
      try {
        await request(ctx, filePath(file.id), {}, { method: 'DELETE' });
      } catch (error) {
        if (error.code !== 'missing') throw error;
      }
    }
  }

  async function cleanupAfterSave(ctx, sourceId, keepId, saved) {
    try {
      await pruneRecoveries(ctx, sourceId, keepId);
    } catch (error) {
      const warning = failure('cleanup',
        'La jornada se guardó, pero no se pudieron eliminar todas las recuperaciones antiguas. Se volverá a intentar al próximo guardado.',
        error);
      warning.saved = saved;
      throw warning;
    }
  }

  async function list(ctx) {
    const folder = await ensureFolder(ctx);
    return listFiles(ctx, "trashed = false and '" + folder.id + "' in parents and appProperties has { key='app' and value='" + APP +
      "' } and appProperties has { key='role' and value='main' }");
  }

  async function exclusive(operation) {
    if (mutating) throw failure('busy', 'Ya hay una operación de escritura en curso. Espera a que termine.');
    const ctx = current();
    mutating = true;
    try {
      return await operation(ctx);
    } finally {
      mutating = false;
    }
  }

  function validateText(text) {
    if (typeof text !== 'string') throw failure('invalid', 'El contenido para Drive debe ser texto JSON.');
    try {
      JSON.parse(text);
    } catch (error) {
      throw failure('invalid', 'El contenido no es JSON válido. No se ha enviado a Drive.', error);
    }
  }

  async function create(ctx, key, role, text, name, extra = {}, parentId, mimeType = 'application/json') {
    validateText(text);
    key = ctx.account.id + ':' + key;
    let operation = creations.get(key);
    if (operation && operation.text !== text) {
      throw failure('uncertain', 'Hay una creación anterior sin confirmar con otro contenido. Revisa los archivos de Drive antes de crear otro.');
    }
    if (!operation) {
      const generated = await json(ctx, 'files/generateIds', { count: 1, space: 'drive', type: 'files' });
      if (!generated.ids?.[0]) throw failure('response', 'Drive no ha reservado un identificador de archivo. No se ha creado nada.');
      operation = {
        text,
        metadata: {
          id: generated.ids[0],
          name,
          mimeType,
          ...(parentId ? { parents: [parentId] } : {}),
          appProperties: { app: APP, role, ...extra }
        },
        attempted: false
      };
      creations.set(key, operation);
    }
    const confirm = async () => {
      const result = mimeType === FOLDER_MIME
        ? { file: await getMetadata(ctx, operation.metadata.id) }
        : await snapshot(ctx, operation.metadata.id);
      if (mimeType !== FOLDER_MIME && result.text !== operation.text) {
        throw failure('conflict', 'El archivo creado tiene otro contenido en Drive. Revisa la versión remota.');
      }
      creations.delete(key);
      return result.file;
    };
    if (operation.attempted) {
      try {
        return await confirm();
      } catch (error) {
        if (error.code !== 'missing') throw error;
        // A reserved ID makes retrying a failed creation idempotent (409 if it exists).
      }
    }
    operation.attempted = true;
    try {
      if (mimeType === FOLDER_MIME) {
        await json(ctx, 'files', { fields: FIELDS }, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify(operation.metadata)
        });
      } else {
        const boundary = 'jornada_' + window.crypto.randomUUID().replace(/-/g, '');
        const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(operation.metadata) + '\r\n--' + boundary +
          '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + text + '\r\n--' + boundary + '--\r\n';
        await request(ctx, 'files', { uploadType: 'multipart', fields: FIELDS }, {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
          body
        }, true);
      }
    } catch (error) {
      if (!['network', 'remote', 'response', 'conflict'].includes(error.code)) {
        if (error.status && error.status < 500) creations.delete(key);
        throw error;
      }
      try {
        return await confirm();
      } catch (confirmationError) {
        if (confirmationError.code !== 'missing') throw confirmationError;
        throw failure('uncertain', 'No se ha confirmado la creación en Drive. Se conserva el identificador reservado para no crear duplicados al reintentar.', error);
      }
    }
    return confirm();
  }

  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  async function createMain(text) {
    return exclusive(async ctx => {
      validateText(text);
      const key = ctx.account.id + ':main';
      // Reconcile an uncertain creation by its reserved ID, not by a possibly stale list.
      const folder = await ensureFolder(ctx);
      if (!creations.has(key) && (await list(ctx)).length) {
        throw failure('conflict', 'Ya existe un archivo principal en esta cuenta. Vuelve a consultar la lista y ábrelo en lugar de crear otro.');
      }
      return create(ctx, 'main', 'main', text, 'jornada_laboral.json', {}, folder.id);
    });
  }

  async function write(id, text, base, options = {}) {
    return exclusive(async ctx => {
      validateText(text);
      if (base?.file?.id !== id || typeof base.file.version !== 'string') {
        throw failure('conflict', 'Falta la versión de Drive desde la que estás editando. Vuelve a cargar el archivo sin descartar tu borrador.');
      }
      const baseVersion = base.file.version;
      const key = ctx.account.id + ':' + id;
      const pending = writes.get(key);
      let remote = await snapshot(ctx, id);
      if (pending) {
        if (remote.text === pending.text) {
          writes.delete(key);
          if (text === pending.text) {
            await cleanupAfterSave(ctx, id, pending.recoveryId, remote);
            return remote
          }
          // A later local edit must supply the newly confirmed base, never clear it as saved.
          throw failure('conflict', 'Se ha confirmado el guardado anterior, pero hay otro contenido pendiente. Revisa la versión de Drive antes de guardarlo.');
        }
        if (remote.file.version !== pending.version) {
          writes.delete(key);
          throw failure('conflict', 'Drive contiene una versión distinta tras el guardado incierto. Revisa el archivo antes de volver a guardar.');
        }
        if (options.retryUncertain !== true) {
          throw failure('uncertain', 'El guardado anterior sigue sin confirmar. No se repetirá automáticamente: conserva el borrador y vuelve a comprobar Drive.');
        }
        if (remote.file.version !== baseVersion) {
          throw failure('conflict', 'La versión base no coincide con Drive. Revisa el archivo antes de autorizar otro intento de guardado.');
        }
        // Only an explicit user-confirmed retry can release an unchanged pending write.
        writes.delete(key);
      }
      if (remote.file.version !== baseVersion) {
        throw failure('conflict', 'Otra sesión ha cambiado el archivo de Drive. Carga o revisa esa versión antes de reemplazarla.');
      }
      if (remote.text === text) {
        await cleanupAfterSave(ctx, id, null, remote);
        return remote
      }
      /*
       * Drive v3 files.update does not document a browser-usable If-Match contract.
       * Do not infer it from an exposed ETag. Preserve remote data, then recheck.
       * This is NOT atomic: another device can write between this check and PATCH.
       * The recovery file protects the observed version, not an unseen racing edit.
       */
      const recoveryFolder = await ensureRecoveryFolder(ctx);
      const recovery = await create(ctx, 'recovery:' + id + ':' + remote.file.version, 'recovery', remote.text,
        'jornada_laboral_recuperacion_' + stamp() + '.json',
        { sourceId: id, sourceVersion: remote.file.version }, recoveryFolder.id);
      const latest = await getMetadata(ctx, id);
      if (latest.version !== remote.file.version) {
        throw failure('conflict', 'El archivo ha cambiado mientras se conservaba la copia de recuperación. No se ha reemplazado.');
      }
      writes.set(key, { text, version: latest.version, recoveryId: recovery.id });
      let uploadError = null;
      try {
        await request(ctx, filePath(id), { uploadType: 'media', fields: FIELDS }, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: text
        }, true);
      } catch (error) {
        uploadError = error;
        if (error.status && error.status < 500) {
          // 4xx responses are definite rejections, not an invitation to retry.
          writes.delete(key);
          throw error;
        }
      }
      try {
        remote = await snapshot(ctx, id);
      } catch (error) {
        throw failure(error.code === 'auth' ? 'auth' : 'uncertain',
          'No se ha podido verificar el guardado. Conserva tus cambios y vuelve a comprobar Drive antes de guardar de nuevo.', error);
      }
      if (remote.text === text) {
        writes.delete(key);
        await cleanupAfterSave(ctx, id, recovery.id, remote);
        return remote;
      }
      if (remote.file.version !== latest.version) {
        writes.delete(key);
        throw failure('conflict', 'El contenido actual de Drive no coincide con lo enviado. No se marcará como guardado; revisa también la copia de recuperación.');
      }
      throw failure('uncertain', 'Drive no ha confirmado el contenido enviado. Se conserva el borrador y no se repetirá la escritura a ciegas.', uploadError);
    });
  }

  window.JornadaDrive = Object.freeze({
    ready,
    connected,
    connect,
    disconnect,
    listMain: async () => list(current()),
    createMain,
    read: async id => snapshot(current(), id),
    metadata: async id => getMetadata(current(), id),
    write,
    backup: text => exclusive(async ctx => {
      const folder = await ensureFolder(ctx);
      return create(ctx, 'backup', 'backup', text, 'jornada_laboral_copia_' + stamp() + '.json', {}, folder.id);
    })
  });
})();
