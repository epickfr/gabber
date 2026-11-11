(() => {
  'use strict';

  const cfg = window.EPICK_CONFIG || {};
  const configured = Boolean(
    window.supabase &&
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
    !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY')
  );

  let sb = null;
  if (configured) {
    try {
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    } catch (error) {
      console.error('[epick-chat] bad Supabase config', error);
    }
  }

  const $id = (id) => document.getElementById(id);

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === null || value === undefined) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'style') node.setAttribute('style', value);
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value);
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function linkify(text) {
    const fragment = document.createDocumentFragment();
    const raw = String(text || '');
    const re = /https?:\/\/[^\s<>"']+/gi;
    let last = 0;
    let match;

    while ((match = re.exec(raw))) {
      let url = match[0];
      const trailing = url.match(/[.,;:!?)\]]+$/);
      if (trailing) url = url.slice(0, -trailing[0].length);
      if (!url || url.length < 10) continue;

      if (match.index > last) {
        fragment.append(document.createTextNode(raw.slice(last, match.index)));
      }
      fragment.append(h('a', {
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: url
      }));
      last = match.index + url.length;
    }

    if (last < raw.length) fragment.append(document.createTextNode(raw.slice(last)));
    return fragment;
  }

  const fmtTime = (iso) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const initial = (name) => (name || '?').slice(0, 1).toUpperCase();

  const IMAGE_URL_RE = /(https?:\/\/[^\s<>"']+?\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s<>"']*)?)/i;

  const AVATAR_COLORS = ['#0a7d32', '#7a2fbf', '#b8860b', '#c0392b', '#1f6feb', '#a0522d', '#008b8b', '#d2691e'];
  const AUTH_EMAIL_DOMAIN = '@epick.local';
  const authEmail = (username) => String(username || '').trim().toLowerCase() + AUTH_EMAIL_DOMAIN;

  function avatarNode(person, extraClass) {
    const cls = 'avatar' + (extraClass ? ' ' + extraClass : '');
    const color = (person && person.color) || '#555555';
    const name = (person && person.username) || '?';

    if (person && person.avatar_url) {
      const img = h('img', {
        class: cls + ' avatar-img',
        src: person.avatar_url,
        alt: '',
        loading: 'lazy',
        referrerpolicy: 'no-referrer'
      });
      img.addEventListener('error', () => {
        img.replaceWith(h('span', { class: cls, style: 'background-color:' + color }, initial(name)));
      });
      return img;
    }

    return h('span', { class: cls, style: 'background-color:' + color }, initial(name));
  }

  function bannerStyle(url) {
    if (!url) return '';
    const safe = String(url).replace(/["'\\()\s]/g, '');
    return 'background-image:url("' + safe + '")';
  }

  function imageGate(url) {
    const box = h('div', { class: 'embed-gate' },
      h('div', { class: 'embed-warn', text: 'This image may contain sensitive or offensive content.' }),
      h('div', { class: 'embed-actions' },
        h('button', {
          type: 'button',
          class: 'btn tiny',
          text: 'view anyway',
          onclick: () => reveal()
        }),
        h('a', {
          class: 'btn tiny',
          href: url,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'open in new tab'
        })
      )
    );

    function reveal() {
      const img = h('img', {
        class: 'embed-img',
        src: url,
        alt: 'embedded image',
        loading: 'lazy',
        referrerpolicy: 'no-referrer'
      });
      img.addEventListener('error', () => {
        img.replaceWith(h('div', { class: 'embed-broken', text: 'That image could not be loaded.' }));
      });
      box.replaceWith(h('div', { class: 'embed' }, img));
    }

    return box;
  }

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function randomColor() {
    const colors = ['#0a7d32', '#7a2fbf', '#b8860b', '#c0392b', '#1f6feb', '#a0522d', '#008b8b', '#d2691e'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

  function freshState() {
    return {
      session: null,
      me: null,
      profile: null,
      rooms: [],
      myRoomIds: new Set(),
      roomCounts: new Map(),
      links: [],
      people: new Map(),
      friends: [],
      incoming: [],
      outgoing: [],
      threadToFriend: new Map(),
      online: new Set(),
      unread: new Map(),
      current: null,
      messages: [],
      members: [],
      convChannel: null,
      globalChannel: null,
      presenceChannel: null,
      searchResults: null,
      booting: false,
      toastTimer: null,
      editor: null,
      viewingProfile: null,
      uploading: false,
      replyTo: null,
      adminUsers: []
    };
  }
  let state = freshState();

  const ui = {
    app: $id('app-window'),
    auth: $id('auth-overlay'),
    authMain: $id('auth-main'),
    setupPanel: $id('setup-panel'),
    authTabs: $id('auth-tabs'),
    loginForm: $id('login-form'),
    registerForm: $id('register-form'),
    loginUsername: $id('login-username'),
    loginPassword: $id('login-password'),
    registerUsername: $id('register-username'),
    registerDisplay: $id('register-display'),
    registerPassword: $id('register-password'),
    authError: $id('auth-error'),
    appBody: $id('app-body'),
    sidebar: $id('sidebar'),
    sidebarToggle: $id('sidebar-toggle'),
    sidebarMe: $id('sidebar-me'),
    myRooms: $id('my-rooms'),
    publicRooms: $id('public-rooms'),
    friendCount: $id('friend-count'),
    friendRequests: $id('friend-requests'),
    friends: $id('friends'),
    addFriendForm: $id('add-friend-form'),
    friendSearch: $id('friend-search'),
    friendResults: $id('friend-results'),
    newRoomBtn: $id('new-room-btn'),
    joinRoomBtn: $id('join-room-btn'),
    channelName: $id('channel-name'),
    channelTopic: $id('channel-topic'),
    channelActions: $id('channel-actions'),
    messages: $id('messages'),
    composer: $id('composer'),
    messageInput: $id('message-input'),
    userlistTitle: $id('userlist-title'),
    memberList: $id('member-list'),
    statusDot: $id('status-dot'),
    statusConnection: $id('status-connection'),
    statusUser: $id('status-user'),
    statusOnline: $id('status-online'),
    statusClock: $id('status-clock'),
    logoutBtn: $id('logout-btn'),
    headerUser: $id('header-user'),
    editProfileBtn: $id('edit-profile-btn'),
    myCard: $id('my-card'),
    imageBtn: $id('image-btn'),
    imageFile: $id('image-file'),
    profileModal: $id('profile-modal'),
    profileClose: $id('profile-close'),
    profileCancel: $id('profile-cancel'),
    profileSave: $id('profile-save'),
    profileDisplay: $id('profile-display'),
    profileBio: $id('profile-bio'),
    profileBioCount: $id('profile-bio-count'),
    profileColors: $id('profile-colors'),
    profileBanners: $id('profile-banners'),
    profileAvatarFile: $id('profile-avatar-file'),
    profileBannerFile: $id('profile-banner-file'),
    profileAvatarPreview: $id('profile-avatar-preview'),
    profileBannerPreview: $id('profile-banner-preview'),
    replyBar: $id('reply-bar'),
    replyText: $id('reply-text'),
    replyCancel: $id('reply-cancel'),
    banNotice: $id('ban-notice'),
    composerSubmit: $id('composer-submit'),
    adminBtn: $id('admin-btn'),
    adminModal: $id('admin-modal'),
    adminClose: $id('admin-close'),
    adminDone: $id('admin-done'),
    adminUsers: $id('admin-users'),
    adminRooms: $id('admin-rooms'),
    adminAnnounce: $id('admin-announce'),
    adminAnnounceBtn: $id('admin-announce-btn'),
    toast: $id('toast')
  };

  function setAuthError(message, kind) {
    ui.authError.textContent = message || '';
    ui.authError.hidden = !message;
    ui.authError.className = 'auth-error' + (kind === 'ok' ? ' ok' : '');
  }

  function friendlyAuthError(error) {
    const message = (error && error.message) || 'Something went wrong.';
    if (/invalid login credentials/i.test(message)) return 'Wrong username or password.';
    if (/email not confirmed/i.test(message)) {
      return 'Sign-in is not enabled yet. Turn off Confirm email in Supabase: Authentication -> Providers -> Email.';
    }
    if (/user already registered/i.test(message)) return 'That username is already registered. Try signing in.';
    if (/password should be at least/i.test(message)) return 'Password must be at least 6 characters.';
    if (/username is already taken/i.test(message)) return 'That username is already taken.';
    if (/rate limit/i.test(message)) return 'Too many attempts. Wait a minute and try again.';
    return message;
  }

  function setBusy(form, busy) {
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = busy;
  }

  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3200);
  }

  function init() {
    bindAuth();
    bindApp();
    startClock();

    if (!sb) {
      ui.setupPanel.hidden = false;
      ui.authMain.hidden = true;
      return;
    }

    sb.auth.getSession().then(({ data }) => {
      if (data.session) startApp(data.session);
      else showAuth();
    });

    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        stopApp();
      } else if (session && !state.session && !state.booting) {
        setTimeout(() => startApp(session), 0);
      } else if (session) {
        state.session = session;
      }
    });
  }

  function showAuth() {
    ui.auth.hidden = false;
    ui.app.hidden = true;
    ui.headerUser.hidden = true;
    setAuthError('');
  }

  async function startApp(session) {
    if (state.booting || state.session) return;
    state.booting = true;
    state.session = session;
    state.me = session.user;

    try {
      await ensureProfile();
      await loadFriends();
      await loadRooms();
      await loadThreads();

      ui.auth.hidden = true;
      ui.app.hidden = false;
      ui.headerUser.hidden = false;
      renderAll();

      startPresence();
      startGlobalRealtime();
      ui.statusUser.textContent = state.profile.username;
      setConnection('connected');

      await restoreLastConversation();
    } catch (error) {
      console.error('[epick-chat] startup failed', error);
      setAuthError(error.message || 'Could not start the app.');
      ui.auth.hidden = false;
      ui.app.hidden = true;
      state.session = null;
      state.me = null;
      try { await sb.auth.signOut(); } catch (_) {  }
    } finally {
      state.booting = false;
    }
  }

  function stopApp() {
    if (state.convChannel) { try { sb.removeChannel(state.convChannel); } catch (_) {} }
    if (state.globalChannel) { try { sb.removeChannel(state.globalChannel); } catch (_) {} }
    if (state.presenceChannel) { try { sb.removeChannel(state.presenceChannel); } catch (_) {} }
    state = freshState();
    ui.app.hidden = true;
    ui.auth.hidden = false;
    ui.headerUser.hidden = true;
    ui.adminBtn.hidden = true;
    ui.profileModal.hidden = true;
    ui.adminModal.hidden = true;
    ui.replyBar.hidden = true;
    ui.banNotice.hidden = true;
    ui.messageInput.disabled = false;
    ui.imageBtn.disabled = false;
    ui.composerSubmit.disabled = false;
    ui.messages.replaceChildren();
    ui.memberList.replaceChildren();
    ui.friends.replaceChildren();
    ui.myRooms.replaceChildren();
    ui.publicRooms.replaceChildren();
    ui.friendRequests.replaceChildren();
    ui.friendResults.replaceChildren();
    ui.sidebarMe.replaceChildren();
    ui.myCard.replaceChildren();
    ui.channelName.textContent = '-';
    ui.channelTopic.textContent = 'select a room or a friend to start chatting';
    ui.channelActions.replaceChildren();
    setConnection('offline');
    updateTitle();
  }

  async function ensureProfile() {
    const { data, error } = await sb
      .from('profiles')
      .select('*')
      .eq('id', state.me.id)
      .maybeSingle();
    if (error) throw error;

    if (data) {
      state.profile = data;
      state.people.set(data.id, data);
      return;
    }

    const meta = state.me.user_metadata || {};
    let base = String(meta.username || 'user')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '');
    if (base.length < 3) base = 'user' + Math.floor(100 + Math.random() * 900);
    base = base.slice(0, 16);

    for (let attempt = 0; attempt < 5; attempt++) {
      const username = attempt === 0 ? base : base + Math.floor(1000 + Math.random() * 9000);
      const { data: created, error: insertError } = await sb
        .from('profiles')
        .insert({
          id: state.me.id,
          username,
          display_name: meta.display_name || username,
          color: randomColor()
        })
        .select()
        .single();

      if (!insertError) {
        state.profile = created;
        state.people.set(created.id, created);
        return;
      }
      if (!/duplicate|unique/i.test(insertError.message)) throw insertError;
    }
    throw new Error('Could not create a profile. Please try again.');
  }

  function bindAuth() {
    ui.authTabs.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;
      const name = tab.dataset.tab;
      Array.from(ui.authTabs.querySelectorAll('.auth-tab')).forEach((item) => {
        item.classList.toggle('active', item === tab);
      });
      ui.loginForm.hidden = name !== 'login';
      ui.registerForm.hidden = name !== 'register';
      setAuthError('');
    });

    ui.loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setAuthError('');
      setBusy(ui.loginForm, true);
      const id = ui.loginUsername.value.trim().toLowerCase();
      const email = id.indexOf('@') === -1 ? authEmail(id) : id;
      const { error } = await sb.auth.signInWithPassword({
        email,
        password: ui.loginPassword.value
      });
      setBusy(ui.loginForm, false);
      if (error) setAuthError(friendlyAuthError(error));
    });

    ui.registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setAuthError('');

      const username = ui.registerUsername.value.trim().toLowerCase();
      const displayName = ui.registerDisplay.value.trim();
      const password = ui.registerPassword.value;

      if (!/^[a-z0-9_]{3,20}$/.test(username)) {
        setAuthError('Username must be 3–20 characters: letters, numbers, underscores.');
        return;
      }
      if (password.length < 6) {
        setAuthError('Password must be at least 6 characters.');
        return;
      }

      setBusy(ui.registerForm, true);

      const { data: available, error: checkError } = await sb.rpc('username_available', {
        p_username: username
      });

      if (!checkError && available === false) {
        setBusy(ui.registerForm, false);
        setAuthError('That username is already taken. Try another one.');
        return;
      }

      const email = authEmail(username);
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
          data: { username, display_name: displayName || username }
        }
      });

      setBusy(ui.registerForm, false);
      if (error) {
        setAuthError(friendlyAuthError(error));
        return;
      }

      if (!data.session) {
        const { data: signed, error: signInError } = await sb.auth.signInWithPassword({
          email,
          password
        });

        if (!signInError && signed.session) {
          startApp(signed.session);
          return;
        }

        setAuthError(
          'Account created, but sign-in is blocked. Turn off Confirm email in Supabase: ' +
          'Authentication -> Providers -> Email -> Confirm email.',
          'ok'
        );
        ui.registerForm.reset();
      } else {
        startApp(data.session);
      }
    });
  }

  function bindApp() {
    ui.logoutBtn.addEventListener('click', async () => {
      await sb.auth.signOut();
    });

    ui.editProfileBtn.addEventListener('click', openProfileEditor);
    ui.myCard.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="edit-profile"]')) openProfileEditor();
    });

    ui.profileClose.addEventListener('click', closeProfileEditor);
    ui.profileCancel.addEventListener('click', closeProfileEditor);
    ui.profileSave.addEventListener('click', saveProfile);
    ui.profileModal.addEventListener('click', (event) => {
      if (event.target === ui.profileModal) closeProfileEditor();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!ui.profileModal.hidden) closeProfileEditor();
      if (!ui.adminModal.hidden) closeAdminPanel();
    });
    ui.profileBio.addEventListener('input', () => {
      ui.profileBioCount.textContent = String(ui.profileBio.value.length);
    });
    ui.profileColors.addEventListener('click', (event) => {
      const swatch = event.target.closest('[data-color]');
      if (!swatch || !state.editor) return;
      state.editor.color = swatch.dataset.color;
      renderEditorPreviews();
    });
    ui.profileBanners.addEventListener('click', (event) => {
      const tile = event.target.closest('[data-banner]');
      if (!tile || !state.editor) return;
      state.editor.banner_url = tile.dataset.banner || '';
      renderEditorPreviews();
    });
    ui.profileAvatarFile.addEventListener('change', async () => {
      const file = ui.profileAvatarFile.files && ui.profileAvatarFile.files[0];
      ui.profileAvatarFile.value = '';
      if (!file || !state.editor) return;
      const url = await uploadImage(file, 'avatars');
      if (!url) return;
      state.editor.avatar_url = url;
      renderEditorPreviews();
      toast('Photo uploaded. Press save profile.');
    });
    ui.profileBannerFile.addEventListener('change', async () => {
      const file = ui.profileBannerFile.files && ui.profileBannerFile.files[0];
      ui.profileBannerFile.value = '';
      if (!file || !state.editor) return;
      const url = await uploadImage(file, 'banners');
      if (!url) return;
      state.editor.banner_url = url;
      renderEditorPreviews();
      toast('Banner uploaded. Press save profile.');
    });

    ui.imageBtn.addEventListener('click', () => ui.imageFile.click());
    ui.imageFile.addEventListener('change', async () => {
      const file = ui.imageFile.files && ui.imageFile.files[0];
      ui.imageFile.value = '';
      if (file) await sendImageFile(file);
    });

    ui.memberList.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="close-profile"]')) {
        state.viewingProfile = null;
        renderMembers();
        return;
      }
      const member = event.target.closest('[data-member-id]');
      if (member) {
        state.viewingProfile = member.dataset.memberId;
        renderMembers();
      }
    });

    ui.replyCancel.addEventListener('click', cancelReply);

    ui.messages.addEventListener('click', (event) => {
      const del = event.target.closest('[data-delete]');
      if (del) {
        deleteMessage(del.dataset.delete);
        return;
      }
      const rep = event.target.closest('[data-reply]');
      if (rep) startReply(rep.dataset.reply);
    });

    ui.adminBtn.addEventListener('click', openAdminPanel);
    ui.adminClose.addEventListener('click', closeAdminPanel);
    ui.adminDone.addEventListener('click', closeAdminPanel);
    ui.adminModal.addEventListener('click', (event) => {
      if (event.target === ui.adminModal) {
        closeAdminPanel();
        return;
      }
      const fun = event.target.closest('[data-fun]');
      if (fun) runFunCommand(fun.dataset.fun);
    });
    ui.adminAnnounceBtn.addEventListener('click', sendAnnouncement);
    ui.adminUsers.addEventListener('change', (event) => {
      const select = event.target.closest('[data-rank-user]');
      if (select) changeRank(select.dataset.rankUser, select.value);
    });
    ui.adminUsers.addEventListener('click', (event) => {
      const button = event.target.closest('[data-ban-user]');
      if (!button) return;
      const person = state.adminUsers.find((item) => item.username === button.dataset.banUser);
      if (!person) return;
      if (person.banned) unbanUser(person.username);
      else banUser(person.username);
    });
    ui.adminRooms.addEventListener('click', (event) => {
      const button = event.target.closest('[data-admin-room]');
      if (button) adminDeleteRoom(button.dataset.adminRoom);
    });

    ui.composer.addEventListener('submit', sendMessage);

    ui.newRoomBtn.addEventListener('click', openNewRoomModal);
    ui.joinRoomBtn.addEventListener('click', openJoinRoomModal);

    ui.addFriendForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await searchPeople(ui.friendSearch.value.trim());
    });

    ui.friendResults.addEventListener('click', (event) => {
      const button = event.target.closest('[data-add-friend]');
      if (button) addFriend(button.dataset.addFriend);
    });

    ui.friendRequests.addEventListener('click', (event) => {
      const accept = event.target.closest('[data-accept]');
      const decline = event.target.closest('[data-decline]');
      if (accept) acceptRequest(accept.dataset.accept);
      if (decline) declineRequest(decline.dataset.decline);
    });

    ui.myRooms.addEventListener('click', onRoomClick);
    ui.publicRooms.addEventListener('click', onRoomClick);

    ui.friends.addEventListener('click', (event) => {
      const button = event.target.closest('[data-friend-id]');
      if (button) openDM(button.dataset.friendId);
    });

    ui.channelActions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'copy-invite') copyText(button.dataset.code || '');
      if (action === 'leave-room') confirmLeaveRoom();
      if (action === 'delete-room') confirmDeleteRoom();
      if (action === 'unfriend') confirmRemoveFriend();
    });

    ui.sidebarToggle.addEventListener('click', () => {
      ui.appBody.classList.toggle('sidebar-open');
    });

    ui.appBody.addEventListener('click', (event) => {
      if (isMobile() && ui.appBody.classList.contains('sidebar-open')) {
        if (!event.target.closest('.sidebar') && !event.target.closest('#sidebar-toggle')) {
          ui.appBody.classList.remove('sidebar-open');
        }
      }
    });

    window.addEventListener('beforeunload', () => {
      if (state.convChannel) sb.removeChannel(state.convChannel);
      if (state.globalChannel) sb.removeChannel(state.globalChannel);
      if (state.presenceChannel) sb.removeChannel(state.presenceChannel);
    });
  }

  function onRoomClick(event) {
    const button = event.target.closest('[data-room-id]');
    if (!button) return;
    const room = state.rooms.find((r) => r.id === button.dataset.roomId);
    if (room) openRoom(room);
  }

  function startClock() {
    const tick = () => {
      ui.statusClock.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
    };
    tick();
    setInterval(tick, 1000);
  }

  function setConnection(status) {
    ui.statusConnection.textContent = status;
    ui.statusDot.className = 'status-dot ' + status;
  }

  function updateTitle() {
    const total = Array.from(state.unread.values()).reduce((sum, n) => sum + n, 0);
    document.title = total ? `(${total}) Epick Chat` : 'Epick Chat - free web chat';
  }

  async function loadFriends() {
    const { data: links, error } = await sb.from('friendships').select('*');
    if (error) throw error;

    state.links = links || [];
    const ids = new Set();
    for (const link of state.links) {
      if (link.requester !== state.me.id) ids.add(link.requester);
      if (link.addressee !== state.me.id) ids.add(link.addressee);
    }

    if (ids.size) {
      const { data: profiles, error: profileError } = await sb
        .from('profiles')
        .select('*')
        .in('id', Array.from(ids));
      if (profileError) throw profileError;
      (profiles || []).forEach((person) => state.people.set(person.id, person));
    }

    state.friends = [];
    state.incoming = [];
    state.outgoing = [];

    for (const link of state.links) {
      const otherId = link.requester === state.me.id ? link.addressee : link.requester;
      const person = state.people.get(otherId);
      if (!person) continue;
      const entry = { link, person };
      if (link.status === 'accepted') state.friends.push(entry);
      else if (link.addressee === state.me.id) state.incoming.push(entry);
      else state.outgoing.push(entry);
    }

    state.friends.sort((a, b) => a.person.username.localeCompare(b.person.username));
  }

  async function loadRooms() {
    const [{ data: rooms, error: roomsError }, { data: members, error: membersError }] = await Promise.all([
      sb.from('rooms').select('*').order('created_at', { ascending: true }),
      sb.from('room_members').select('room_id, user_id')
    ]);
    if (roomsError) throw roomsError;
    if (membersError) throw membersError;

    state.rooms = rooms || [];
    state.myRoomIds = new Set();
    state.roomCounts = new Map();

    for (const member of members || []) {
      state.roomCounts.set(member.room_id, (state.roomCounts.get(member.room_id) || 0) + 1);
      if (member.user_id === state.me.id) state.myRoomIds.add(member.room_id);
    }
  }

  async function loadThreads() {
    const { data, error } = await sb.from('dm_threads').select('*');
    if (error) throw error;
    state.threadToFriend = new Map();
    for (const thread of data || []) {
      const other = thread.user_a === state.me.id ? thread.user_b : thread.user_a;
      state.threadToFriend.set(thread.id, other);
    }
  }

  async function loadMembers(roomId) {
    const { data, error } = await sb
      .from('room_members')
      .select('user_id, joined_at, profile:profiles!room_members_user_id_fkey(*)')
      .eq('room_id', roomId);
    if (error) {
      console.error('[epick-chat] members', error);
      return;
    }
    if (!state.current || state.current.type !== 'room' || state.current.id !== roomId) return;

    state.members = (data || [])
      .map((row) => row.profile)
      .filter(Boolean);

    for (const person of state.members) state.people.set(person.id, person);
  }

  function renderAll() {
    renderMe();
    renderRooms();
    renderFriends();
    renderRequests();
    renderHeader();
    renderMessages();
    renderMembers();
    renderStatus();
  }

  function profileCardNode(person, online, options) {
    const opts = options || {};
    const card = h('div', { class: 'profile-card' },
      h('div', { class: 'profile-banner', style: bannerStyle(person.banner_url) }),
      h('div', { class: 'profile-head' },
        avatarNode(person, 'big'),
        h('div', { class: 'profile-head-text' },
          h('div', { class: 'profile-name' }, person.username, rankBadge(person)),
          h('div', { class: 'profile-sub', text: person.display_name || '' }),
          h('div', {
            class: 'presence ' + (online ? 'on' : 'off'),
            text: online ? '* online *' : 'offline'
          })
        )
      ),
      h('div', { class: 'profile-bio' }, linkify(person.bio || 'no bio yet.'))
    );

    if (opts.edit) {
      card.append(h('button', {
        type: 'button',
        class: 'btn tiny wide',
        'data-action': 'edit-profile',
        text: 'edit profile'
      }));
    }

    return card;
  }

  function renderMe() {
    if (!state.profile) {
      ui.sidebarMe.replaceChildren();
      ui.myCard.replaceChildren();
      return;
    }

    const person = state.profile;

    ui.sidebarMe.replaceChildren(
      avatarNode(person, 'small'),
      h('span', { class: 'me-text' },
        h('strong', {}, person.username, rankBadge(person)),
        h('br'),
        h('small', { text: person.display_name || 'online now' })
      )
    );

    ui.myCard.replaceChildren(
      h('div', { class: 'profile-banner', style: bannerStyle(person.banner_url) }),
      h('div', { class: 'profile-head' },
        avatarNode(person, 'big'),
        h('div', { class: 'profile-head-text' },
          h('div', { class: 'profile-name' }, person.username, rankBadge(person)),
          h('div', { class: 'profile-sub', text: person.display_name || '' })
        )
      ),
      h('div', { class: 'profile-bio' }, linkify(person.bio || 'no bio yet. click edit profile to add one.')),
      h('button', {
        type: 'button',
        class: 'btn tiny wide',
        'data-action': 'edit-profile',
        text: 'edit profile'
      })
    );

    applyBanState();
  }

  function roomItem(room) {
    const active = state.current && state.current.type === 'room' && state.current.id === room.id;
    const unread = state.unread.get('room:' + room.id) || 0;
    const count = state.roomCounts.get(room.id) || 0;

    return h('button', {
      type: 'button',
      class: 'side-item' + (active ? ' active' : ''),
      'data-room-id': room.id,
      title: (room.topic || '') + (room.is_private ? ' [private room]' : '')
    },
      h('span', { class: 'room-mark', text: room.is_private ? '*' : '#' }),
      h('span', { class: 'label', text: room.name }),
      unread ? h('span', { class: 'badge', text: String(unread) })
             : h('span', { class: 'count', text: '(' + count + ')' })
    );
  }

  function renderRooms() {
    const mine = state.rooms
      .filter((room) => state.myRoomIds.has(room.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    const publicRooms = state.rooms
      .filter((room) => !room.is_private && !state.myRoomIds.has(room.id))
      .sort((a, b) => a.name.localeCompare(b.name));

    ui.myRooms.replaceChildren();
    ui.publicRooms.replaceChildren();

    if (mine.length) mine.forEach((room) => ui.myRooms.append(roomItem(room)));
    else ui.myRooms.append(h('div', { class: 'muted tiny-pad', text: 'no rooms joined' }));

    if (publicRooms.length) publicRooms.forEach((room) => ui.publicRooms.append(roomItem(room)));
    else ui.publicRooms.append(h('div', { class: 'muted tiny-pad', text: 'no public rooms' }));
  }

  function renderFriends() {
    ui.friends.replaceChildren();
    ui.friendCount.textContent = state.friends.length ? '(' + state.friends.length + ')' : '';

    if (!state.friends.length) {
      ui.friends.append(h('div', { class: 'muted tiny-pad', text: 'no friends yet' }));
      return;
    }

    for (const { person } of state.friends) {
      const online = state.online.has(person.id);
      const active = state.current && state.current.type === 'dm' && state.current.person.id === person.id;
      const unread = state.unread.get('friend:' + person.id) || 0;

      ui.friends.append(h('button', {
        type: 'button',
        class: 'side-item' + (active ? ' active' : ''),
        'data-friend-id': person.id,
        title: person.display_name || person.username
      },
        h('span', { class: 'dot' + (online ? ' on' : '') }),
        h('span', { class: 'label', text: person.username }),
        unread ? h('span', { class: 'badge', text: String(unread) }) : null
      ));
    }
  }

  function renderRequests() {
    ui.friendRequests.replaceChildren();

    if (state.incoming.length) {
      const box = h('div', { class: 'requests' },
        h('div', { class: 'muted', text: 'friend requests' })
      );
      for (const { link, person } of state.incoming) {
        box.append(h('div', { class: 'request' },
          h('span', { class: 'label', text: person.username + ' ' }),
          h('span', { class: 'request-actions' },
            h('button', { type: 'button', class: 'btn micro', 'data-accept': link.id, text: 'ok' }),
            h('button', { type: 'button', class: 'btn micro', 'data-decline': link.id, text: 'no' })
          )
        ));
      }
      ui.friendRequests.append(box);
    }

    if (state.outgoing.length) {
      const names = state.outgoing.map((entry) => entry.person.username).join(', ');
      ui.friendRequests.append(h('div', { class: 'outgoing', text: 'waiting on: ' + names }));
    }
  }

  function renderHeader() {
    ui.channelActions.replaceChildren();
    const current = state.current;

    if (!current) {
      ui.channelName.textContent = '-';
      ui.channelTopic.textContent = 'select a room or a friend to start chatting';
      return;
    }

    if (current.type === 'room') {
      const room = current.room;
      ui.channelName.textContent = (room.is_private ? '*' : '#') + ' ' + room.name;
      ui.channelTopic.textContent = room.topic || 'no topic set';

      if (room.is_private && room.invite_code) {
        ui.channelActions.append(
          h('span', { class: 'invite-code', text: 'invite code: ' + room.invite_code }),
          document.createTextNode(' '),
          h('button', {
            type: 'button',
            class: 'btn micro',
            'data-action': 'copy-invite',
            'data-code': room.invite_code,
            text: 'copy'
          })
        );
      }

      if (room.owner === state.me.id) {
        ui.channelActions.append(
          document.createTextNode(' '),
          h('button', { type: 'button', class: 'btn micro danger', 'data-action': 'delete-room', text: 'delete room' })
        );
      } else if (state.myRoomIds.has(room.id)) {
        ui.channelActions.append(
          document.createTextNode(' '),
          h('button', { type: 'button', class: 'btn micro', 'data-action': 'leave-room', text: 'leave room' })
        );
      }
    } else {
      const person = current.person;
      ui.channelName.textContent = '@ ' + person.username;
      ui.channelTopic.textContent = state.online.has(person.id) ? 'online now' : 'offline';
      ui.channelActions.append(
        h('button', { type: 'button', class: 'btn micro danger', 'data-action': 'unfriend', text: 'remove friend' })
      );
    }
  }

  function messageNode(message) {
    const rawBody = message.body || '';
    const isSystem = !message.sender;
    const person = isSystem
      ? { username: 'system', color: '#a8001e' }
      : (message.person || { username: 'unknown', color: '#000000' });

    const mine = !isSystem && message.sender === state.me.id;
    const imageMatch = rawBody.match(IMAGE_URL_RE);
    const onlyImage = Boolean(imageMatch && rawBody.trim() === imageMatch[1]);

    const line = h('div', { class: 'msg-line' },
      h('span', { class: 'ts', text: '[' + fmtTime(message.created_at) + '] ' }),
      h('span', {
        class: 'nick',
        style: 'color:' + (person.color || '#000000'),
        text: '<' + person.username + '> '
      }),
      isSystem ? null : rankBadge(person),
      isSystem
        ? h('span', { class: 'body system-body' }, linkify(rawBody))
        : onlyImage
          ? h('span', { class: 'body muted', text: 'shared an image' })
          : h('span', { class: 'body' }, linkify(rawBody))
    );

    const quote = message.reply_snippet
      ? h('div', { class: 'reply-quote', text: 'replying to ' + message.reply_snippet })
      : null;

    const tools = [];
    if (!isSystem) {
      tools.push(h('button', {
        type: 'button',
        class: 'msg-tool',
        'data-reply': message.id,
        title: 'reply to this message',
        text: 'reply'
      }));
      if (canDeleteMessage(message)) {
        tools.push(h('button', {
          type: 'button',
          class: 'msg-tool danger',
          'data-delete': message.id,
          title: 'delete this message',
          text: 'delete'
        }));
      }
    }

    return h('div', { class: 'msg' + (mine ? ' mine' : '') + (isSystem ? ' system' : '') },
      avatarNode(person, 'msg-avatar'),
      h('div', { class: 'msg-main' },
        quote,
        line,
        imageMatch ? imageGate(imageMatch[1]) : null,
        tools.length ? h('div', { class: 'msg-tools' }, tools) : null
      )
    );
  }

  function renderMessages(forceScroll) {
    ui.messages.replaceChildren();

    if (!state.current) {
      ui.messages.append(h('div', { class: 'empty', text: 'pick a room or a friend from the left.' }));
      return;
    }

    if (!state.messages.length) {
      ui.messages.append(h('div', { class: 'empty', text: 'no messages yet. say something!' }));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const message of state.messages) fragment.append(messageNode(message));
    ui.messages.append(fragment);

    if (forceScroll) scrollToBottom(true);
    else scrollToBottom(false);
  }

  function renderMembers() {
    ui.memberList.replaceChildren();
    const current = state.current;

    if (!current) {
      ui.userlistTitle.textContent = 'PEOPLE';
      return;
    }

    if (current.type === 'dm') {
      ui.userlistTitle.textContent = 'PROFILE';
      const person = state.people.get(current.person.id) || current.person;
      ui.memberList.append(profileCardNode(person, state.online.has(person.id)));
      return;
    }

    if (state.viewingProfile) {
      const person = state.people.get(state.viewingProfile);
      if (person) {
        ui.userlistTitle.textContent = 'PROFILE';
        ui.memberList.append(
          h('button', {
            type: 'button',
            class: 'btn tiny',
            'data-action': 'close-profile',
            text: 'back to room'
          }),
          profileCardNode(person, state.online.has(person.id))
        );
        return;
      }
      state.viewingProfile = null;
    }

    ui.userlistTitle.textContent = 'IN THIS ROOM (' + state.members.length + ')';

    const sorted = [...state.members].sort((a, b) => {
      const aOnline = state.online.has(a.id) ? 0 : 1;
      const bOnline = state.online.has(b.id) ? 0 : 1;
      if (aOnline !== bOnline) return aOnline - bOnline;
      return a.username.localeCompare(b.username);
    });

    for (const person of sorted) {
      ui.memberList.append(h('div', {
        class: 'member',
        'data-member-id': person.id,
        title: 'view ' + person.username + "'s profile"
      },
        h('span', { class: 'dot' + (state.online.has(person.id) ? ' on' : '') }),
        avatarNode(person, 'tiny'),
        h('span', { class: 'label', style: 'color:' + (person.color || '#000000') }, person.username, rankBadge(person))
      ));
    }

    if (!sorted.length) ui.memberList.append(h('div', { class: 'muted tiny-pad', text: 'nobody here yet' }));
  }

  function renderStatus() {
    ui.statusOnline.textContent = state.online.size + ' online';
    ui.statusUser.textContent = state.profile ? state.profile.username : 'guest';
  }

  async function restoreLastConversation() {
    const last = localStorage.getItem('epickchat:last');

    if (last && last.startsWith('dm:')) {
      const friendId = last.slice(3);
      if (state.friends.some((entry) => entry.person.id === friendId)) {
        await openDM(friendId);
        return;
      }
    }

    if (last && last.startsWith('room:')) {
      const room = state.rooms.find((item) => item.id === last.slice(5));
      if (room) {
        await openRoom(room);
        return;
      }
    }

    const lobby = state.rooms.find((room) => room.name.toLowerCase() === 'lobby');
    const first = lobby || state.rooms.find((room) => !room.is_private);

    if (first) await openRoom(first);
    else {
      state.current = null;
      renderHeader();
      renderMessages();
      renderMembers();
    }
  }

  async function openRoom(room) {
    if (!room) return;

    if (!room.is_private && !state.myRoomIds.has(room.id)) {
      const { error } = await sb.from('room_members').insert({
        room_id: room.id,
        user_id: state.me.id
      });
      if (error && error.code !== '23505') {
        toast(error.message);
        return;
      }
      state.myRoomIds.add(room.id);
      state.roomCounts.set(room.id, (state.roomCounts.get(room.id) || 0) + 1);
      loadRooms().then(renderRooms).catch(() => {});
    }

    unsubscribeConversation();
    state.current = { type: 'room', id: room.id, room };
    state.messages = [];
    state.members = [];
    state.viewingProfile = null;
    state.replyTo = null;
    renderReplyBar();
    state.unread.delete('room:' + room.id);
    localStorage.setItem('epickchat:last', 'room:' + room.id);

    renderHeader();
    renderMessages();
    renderRooms();
    renderFriends();
    renderMembers();
    updateTitle();

    await Promise.all([loadRoomMessages(room.id), loadMembers(room.id)]);

    if (!state.current || state.current.type !== 'room' || state.current.id !== room.id) return;

    subscribeConversation();
    renderMessages(true);
    renderMembers();
    renderHeader();
    focusComposer();
    if (isMobile()) ui.appBody.classList.remove('sidebar-open');
  }

  async function openDM(friendId) {
    const person = state.people.get(friendId);
    if (!person) return;

    const { data: threadId, error } = await sb.rpc('get_or_create_dm', { p_other: friendId });
    if (error) {
      toast(error.message);
      return;
    }

    state.threadToFriend.set(threadId, friendId);
    unsubscribeConversation();
    state.current = { type: 'dm', id: threadId, person };
    state.messages = [];
    state.members = [];
    state.viewingProfile = null;
    state.replyTo = null;
    renderReplyBar();
    state.unread.delete('friend:' + friendId);
    localStorage.setItem('epickchat:last', 'dm:' + friendId);

    renderHeader();
    renderMessages();
    renderRooms();
    renderFriends();
    renderMembers();
    updateTitle();

    await loadDMMessages(threadId, friendId);

    if (!state.current || state.current.type !== 'dm' || state.current.id !== threadId) return;

    subscribeConversation();
    renderMessages(true);
    renderMembers();
    renderHeader();
    focusComposer();
    if (isMobile()) ui.appBody.classList.remove('sidebar-open');
  }

  async function loadRoomMessages(roomId) {
    const { data, error } = await sb
      .from('messages')
      .select('id, body, created_at, sender, reply_to, reply_snippet, person:profiles!messages_sender_fkey(username, display_name, color, rank, avatar_url, banner_url, bio)')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      toast(error.message);
      return;
    }
    if (!state.current || state.current.type !== 'room' || state.current.id !== roomId) return;

    state.messages = (data || []).reverse().map((row) => ({
      id: row.id,
      body: row.body,
      created_at: row.created_at,
      sender: row.sender,
      reply_to: row.reply_to,
      reply_snippet: row.reply_snippet,
      person: row.person || state.people.get(row.sender) || { username: 'unknown', color: '#000000' }
    }));
  }

  async function loadDMMessages(threadId, friendId) {
    const { data, error } = await sb
      .from('dm_messages')
      .select('id, body, created_at, sender, reply_to, reply_snippet, person:profiles!dm_messages_sender_fkey(username, display_name, color, rank, avatar_url, banner_url, bio)')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      toast(error.message);
      return;
    }
    if (!state.current || state.current.type !== 'dm' || state.current.id !== threadId) return;

    state.messages = (data || []).reverse().map((row) => ({
      id: row.id,
      body: row.body,
      created_at: row.created_at,
      sender: row.sender,
      reply_to: row.reply_to,
      reply_snippet: row.reply_snippet,
      person: row.person || state.people.get(row.sender) || state.people.get(friendId) || { username: 'unknown', color: '#000000' }
    }));
  }

  function unsubscribeConversation() {
    if (state.convChannel) {
      try { sb.removeChannel(state.convChannel); } catch (_) {  }
      state.convChannel = null;
    }
  }

  function subscribeConversation() {
    const current = state.current;
    if (!current) return;

    const table = current.type === 'room' ? 'messages' : 'dm_messages';
    const column = current.type === 'room' ? 'room_id' : 'thread_id';
    const channel = sb
      .channel('epickchat-conv-' + current.type + '-' + current.id)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table,
        filter: column + '=eq.' + current.id
      }, (payload) => {
        if (!state.current || state.current.type !== current.type || state.current.id !== current.id) return;
        addIncomingMessage(payload.new);
      })
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table,
        filter: column + '=eq.' + current.id
      }, (payload) => {
        if (!state.current || state.current.type !== current.type || state.current.id !== current.id) return;
        if (payload.old) removeMessage(payload.old.id);
      })
      .subscribe();

    state.convChannel = channel;
  }

  async function addIncomingMessage(row) {
    if (!state.current || !row) return;
    if (state.messages.some((message) => String(message.id) === String(row.id))) return;

    let person = state.people.get(row.sender);
    if (!person && row.sender) {
      const { data } = await sb.from('profiles').select('*').eq('id', row.sender).maybeSingle();
      if (data) {
        person = data;
        state.people.set(data.id, data);
      }
    }

    const message = {
      id: row.id,
      body: row.body,
      created_at: row.created_at,
      sender: row.sender,
      reply_to: row.reply_to,
      reply_snippet: row.reply_snippet,
      person: person || { username: 'unknown', color: '#000000' }
    };

    state.messages.push(message);
    ui.messages.append(messageNode(message));
    scrollToBottom(false);
  }

  async function sendBody(body) {
    if (!state.current) return false;
    if (!body) return false;
    if (isBanned()) {
      toast('You are banned from chatting.');
      return false;
    }
    if (body.length > 2000) {
      toast('Message is too long.');
      return false;
    }

    const current = state.current;
    const table = current.type === 'room' ? 'messages' : 'dm_messages';
    const payload = current.type === 'room'
      ? { room_id: current.id, sender: state.me.id, body }
      : { thread_id: current.id, sender: state.me.id, body };

    if (state.replyTo) {
      payload.reply_to = state.replyTo.id;
      payload.reply_snippet = (state.replyTo.person ? state.replyTo.person.username : 'unknown') +
        ': ' + String(state.replyTo.body || '').slice(0, 90);
    }

    const { data, error } = await sb.from(table).insert(payload).select().single();
    if (error) {
      toast(error.message);
      return false;
    }

    state.replyTo = null;
    renderReplyBar();

    if (!state.current || state.current.type !== current.type || state.current.id !== current.id) return true;
    await addIncomingMessage(data);
    scrollToBottom(true);
    return true;
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (isBanned()) {
      toast('You are banned from chatting.');
      return;
    }
    const body = ui.messageInput.value.trim();
    if (!body || !state.current) return;

    if (body.charAt(0) === '/') {
      ui.messageInput.value = '';
      await runCommand(body);
      return;
    }

    ui.messageInput.value = '';
    const ok = await sendBody(body);
    if (!ok) ui.messageInput.value = body;
  }

  async function sendImageFile(file) {
    if (!file || !state.current) return;
    if (isBanned()) {
      toast('You are banned from chatting.');
      return;
    }
    if (state.uploading) {
      toast('Still uploading, hold on.');
      return;
    }

    state.uploading = true;
    toast('Uploading image...');
    try {
      const url = await uploadImage(file, 'chat');
      if (url) await sendBody(url);
    } finally {
      state.uploading = false;
    }
  }

  function scrollToBottom(force) {
    const box = ui.messages;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function focusComposer() {
    if (!isMobile()) ui.messageInput.focus();
  }

  function maybeUnread(table, row) {
    if (!row) return;

    if (table === 'messages') {
      if (!state.myRoomIds.has(row.room_id)) return;
      if (state.current && state.current.type === 'room' && state.current.id === row.room_id) return;
      bumpUnread('room:' + row.room_id);
      return;
    }

    const friendId = state.threadToFriend.get(row.thread_id);
    if (!friendId) return;
    if (state.current && state.current.type === 'dm' && state.current.id === row.thread_id) return;
    bumpUnread('friend:' + friendId);
  }

  function bumpUnread(key) {
    state.unread.set(key, (state.unread.get(key) || 0) + 1);
    renderRooms();
    renderFriends();
    updateTitle();
  }

  function startPresence() {
    if (state.presenceChannel) return;

    const channel = sb.channel('epickchat-online', {
      config: { presence: { key: state.me.id } }
    });

    channel.on('presence', { event: 'sync' }, () => {
      const ids = new Set();
      const presenceState = channel.presenceState();
      Object.keys(presenceState).forEach((key) => {
        (presenceState[key] || []).forEach((entry) => {
          if (entry.user_id) ids.add(entry.user_id);
        });
      });
      state.online = ids;
      renderFriends();
      renderMembers();
      renderStatus();
      renderHeader();
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ user_id: state.me.id, username: state.profile.username });
        setConnection('connected');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setConnection('offline');
      }
    });

    state.presenceChannel = channel;
  }

  const reloadFriendsSoon = debounce(async () => {
    if (!state.session) return;
    try {
      await loadFriends();
      renderFriends();
      renderRequests();
    } catch (error) {
      console.error('[epick-chat] reload friends', error);
    }
  }, 250);

  const reloadRoomsSoon = debounce(async () => {
    if (!state.session) return;
    try {
      await loadRooms();
      renderRooms();

      if (state.current && state.current.type === 'room') {
        const stillThere = state.rooms.some((room) => room.id === state.current.id);
        if (!stillThere) {
          state.current = null;
          renderHeader();
          renderMessages();
          renderMembers();
          return;
        }
        await loadMembers(state.current.id);
        renderMembers();
        renderHeader();
      }
    } catch (error) {
      console.error('[epick-chat] reload rooms', error);
    }
  }, 250);

  function startGlobalRealtime() {
    if (state.globalChannel) return;

    const channel = sb
      .channel('epickchat-events')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
        reloadFriendsSoon();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
        const person = payload.new;
        if (!person || !person.id) return;
        state.people.set(person.id, person);
        if (person.id === state.me.id) {
          const wasBanned = Boolean(state.profile && state.profile.banned);
          state.profile = person;
          renderMe();
          if (!wasBanned && person.banned) toast('You have been banned from chatting.');
          if (wasBanned && !person.banned) toast('Your ban has been lifted.');
        }
        renderFriends();
        renderMembers();
        renderHeader();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, () => {
        reloadRoomsSoon();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members' }, () => {
        reloadRoomsSoon();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        maybeUnread('messages', payload.new);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages' }, (payload) => {
        maybeUnread('dm_messages', payload.new);
      })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnection('offline');
      });

    state.globalChannel = channel;
  }

  async function searchPeople(query) {
    if (!query || query.length < 2) {
      toast('Type at least 2 characters.');
      return;
    }

    const { data, error } = await sb
      .from('profiles')
      .select('id, username, display_name, color, avatar_url')
      .ilike('username', '%' + query + '%')
      .neq('id', state.me.id)
      .limit(8);

    if (error) {
      toast(error.message);
      return;
    }

    state.searchResults = data || [];
    renderFriendResults();
  }

  function renderFriendResults() {
    ui.friendResults.replaceChildren();
    if (!state.searchResults || !state.searchResults.length) return;

    const related = new Map();
    for (const entry of [...state.friends, ...state.incoming, ...state.outgoing]) {
      related.set(entry.person.id, entry.link.status === 'accepted' ? 'friend' : 'pending');
    }

    for (const person of state.searchResults) {
      const status = related.get(person.id);
      ui.friendResults.append(h('div', { class: 'request' },
        h('span', { class: 'label', text: person.username + ' ' }),
        status === 'friend'
          ? h('span', { class: 'muted', text: '(friend)' })
          : status === 'pending'
            ? h('span', { class: 'muted', text: '(pending)' })
            : h('button', {
                type: 'button',
                class: 'btn micro',
                'data-add-friend': person.id,
                text: 'add'
              })
      ));
    }
  }

  async function addFriend(friendId) {
    const { error } = await sb.from('friendships').insert({
      requester: state.me.id,
      addressee: friendId
    });

    if (error) {
      if (error.code === '23505') toast('A friend request already exists.');
      else toast(error.message);
      return;
    }

    toast('Friend request sent.');
    await loadFriends();
    renderFriends();
    renderRequests();
    renderFriendResults();
  }

  async function acceptRequest(linkId) {
    const { error } = await sb.rpc('accept_friend_request', { p_id: linkId });
    if (error) {
      toast(error.message);
      return;
    }
    await loadFriends();
    renderFriends();
    renderRequests();
  }

  async function declineRequest(linkId) {
    const { error } = await sb.from('friendships').delete().eq('id', linkId);
    if (error) {
      toast(error.message);
      return;
    }
    await loadFriends();
    renderFriends();
    renderRequests();
  }

  async function openNewRoomModal() {
    const name = window.prompt('Room name (1-32 characters):');
    if (name === null) return;

    const cleanName = name.trim();
    if (!cleanName) {
      window.alert('Room name is required.');
      return;
    }

    const topic = window.prompt('Room topic (optional):') || '';
    const isPrivate = window.confirm(
      'Make this room private?\n\nOK = private (invite code required)\nCancel = public room'
    );

    const { data: roomId, error } = await sb.rpc('create_room', {
      p_name: cleanName,
      p_topic: topic.trim(),
      p_private: isPrivate
    });

    if (error) {
      window.alert(error.message);
      return;
    }

    await loadRooms();
    renderRooms();

    const room = state.rooms.find((item) => item.id === roomId);
    if (room) await openRoom(room);
  }

  async function openJoinRoomModal() {
    const code = window.prompt('Enter the private room invite code:');
    if (!code) return;

    const { data: roomId, error } = await sb.rpc('join_room_by_code', { p_code: code.trim() });
    if (error) {
      window.alert(error.message);
      return;
    }

    await loadRooms();
    renderRooms();

    const room = state.rooms.find((item) => item.id === roomId);
    if (room) await openRoom(room);
  }

  async function confirmLeaveRoom() {
    const current = state.current;
    if (!current || current.type !== 'room') return;

    const room = current.room;
    if (!window.confirm('Leave #' + room.name + '?')) return;

    const { error } = await sb
      .from('room_members')
      .delete()
      .eq('room_id', room.id)
      .eq('user_id', state.me.id);

    if (error) {
      toast(error.message);
      return;
    }

    state.myRoomIds.delete(room.id);
    state.unread.delete('room:' + room.id);
    state.current = null;

    await loadRooms();
    renderRooms();

    const next = state.rooms.find((item) => item.id !== room.id && !item.is_private)
      || state.rooms.find((item) => item.id !== room.id && state.myRoomIds.has(item.id));

    if (next) {
      await openRoom(next);
    } else {
      renderHeader();
      renderMessages();
      renderMembers();
    }
  }

  async function confirmDeleteRoom() {
    const current = state.current;
    if (!current || current.type !== 'room') return;

    const room = current.room;
    if (room.owner !== state.me.id) return;
    if (!window.confirm('Delete #' + room.name + ' and all of its messages? This cannot be undone.')) return;

    const { error } = await sb.from('rooms').delete().eq('id', room.id);
    if (error) {
      toast(error.message);
      return;
    }

    state.myRoomIds.delete(room.id);
    state.unread.delete('room:' + room.id);
    state.current = null;

    await loadRooms();
    renderRooms();

    const next = state.rooms.find((item) => !item.is_private)
      || state.rooms.find((item) => state.myRoomIds.has(item.id));

    if (next) {
      await openRoom(next);
    } else {
      renderHeader();
      renderMessages();
      renderMembers();
    }
  }

  async function confirmRemoveFriend() {
    const current = state.current;
    if (!current || current.type !== 'dm') return;

    const entry = state.friends.find((item) => item.person.id === current.person.id);
    if (!entry) return;

    if (!window.confirm('Remove ' + current.person.username + ' from your friends?')) return;

    const { error } = await sb.from('friendships').delete().eq('id', entry.link.id);
    if (error) {
      toast(error.message);
      return;
    }

    state.current = null;
    state.unread.delete('friend:' + current.person.id);
    await loadFriends();
    renderFriends();
    renderRequests();
    renderHeader();
    renderMessages();
    renderMembers();

    const lobby = state.rooms.find((room) => room.name.toLowerCase() === 'lobby');
    if (lobby) await openRoom(lobby);
  }

  const STAFF_RANKS = ['owner', 'co-owner', 'admin', 'mod'];

  function rankOf(person) {
    return (person && person.rank) || 'member';
  }

  function isBanned() {
    return Boolean(state.profile && state.profile.banned);
  }

  function isStaff() {
    return !isBanned() && STAFF_RANKS.indexOf(rankOf(state.profile)) !== -1;
  }

  function isAdmin() {
    return !isBanned() && ['owner', 'co-owner', 'admin'].indexOf(rankOf(state.profile)) !== -1;
  }

  function canManageRanks() {
    return !isBanned() && ['owner', 'co-owner'].indexOf(rankOf(state.profile)) !== -1;
  }

  function rankBadge(person) {
    const rank = rankOf(person);
    if (rank === 'member') return null;
    return h('span', { class: 'rank rank-' + rank, text: '(' + rank + ')' });
  }

  function openProfileEditor() {
    const person = state.profile;
    if (!person) return;

    state.editor = {
      display_name: person.display_name || '',
      bio: person.bio || '',
      color: person.color || '#0a7d32',
      avatar_url: person.avatar_url || '',
      banner_url: person.banner_url || ''
    };

    ui.profileDisplay.value = state.editor.display_name;
    ui.profileBio.value = state.editor.bio;
    ui.profileBioCount.textContent = String(state.editor.bio.length);
    renderEditorPreviews();
    ui.profileModal.hidden = false;
    ui.profileDisplay.focus();
  }

  function closeProfileEditor() {
    state.editor = null;
    ui.profileModal.hidden = true;
  }

  function renderEditorPreviews() {
    const editor = state.editor;
    if (!editor || !state.profile) return;

    ui.profileAvatarPreview.replaceChildren(
      avatarNode({
        username: state.profile.username,
        color: editor.color,
        avatar_url: editor.avatar_url
      }, 'big')
    );

    ui.profileBannerPreview.setAttribute('style', bannerStyle(editor.banner_url));

    ui.profileColors.replaceChildren(
      ...AVATAR_COLORS.map((color) => h('button', {
        type: 'button',
        class: 'swatch' + (color === editor.color ? ' active' : ''),
        style: 'background-color:' + color,
        'data-color': color,
        title: color,
        'aria-label': 'avatar colour ' + color
      }))
    );

    const presets = Array.isArray(window.EPICK_BANNERS) ? window.EPICK_BANNERS : [];
    const tiles = [
      h('button', {
        type: 'button',
        class: 'banner-tile' + (editor.banner_url ? '' : ' active'),
        'data-banner': '',
        text: 'no banner'
      })
    ];

    for (const preset of presets) {
      tiles.push(h('button', {
        type: 'button',
        class: 'banner-tile' + (editor.banner_url === preset.file ? ' active' : ''),
        style: bannerStyle(preset.file),
        'data-banner': preset.file,
        title: preset.name,
        'aria-label': 'banner ' + preset.name
      }));
    }

    ui.profileBanners.replaceChildren(...tiles);
  }

  async function uploadImage(file, folder) {
    if (!file) return null;
    if (!/^image\//i.test(file.type || '')) {
      toast('That file is not an image.');
      return null;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast('Images must be 5 MB or smaller.');
      return null;
    }

    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const path = folder + '/' + state.me.id + '/' + Date.now() + '-' +
      Math.random().toString(36).slice(2, 8) + '.' + ext;

    const { error } = await sb.storage
      .from('epick')
      .upload(path, file, { cacheControl: '31536000', contentType: file.type, upsert: false });

    if (error) {
      console.error('[epick-chat] upload failed', error);
      toast(/bucket|policy|row-level/i.test(error.message)
        ? 'Image storage is not ready. Re-run supabase/schema.sql.'
        : error.message);
      return null;
    }

    const { data } = sb.storage.from('epick').getPublicUrl(path);
    return data && data.publicUrl ? data.publicUrl : null;
  }

  async function saveProfile() {
    const editor = state.editor;
    if (!editor || !state.profile) return;

    const display = ui.profileDisplay.value.trim().slice(0, 30);
    const bio = ui.profileBio.value.trim().slice(0, 280);

    ui.profileSave.disabled = true;
    const { data, error } = await sb
      .from('profiles')
      .update({
        display_name: display || state.profile.username,
        bio,
        color: editor.color,
        avatar_url: editor.avatar_url || null,
        banner_url: editor.banner_url || null
      })
      .eq('id', state.me.id)
      .select()
      .single();
    ui.profileSave.disabled = false;

    if (error) {
      toast(/column|schema cache/i.test(error.message)
        ? 'Profile columns are missing. Re-run supabase/schema.sql.'
        : error.message);
      return;
    }

    state.profile = data;
    state.people.set(data.id, data);
    state.editor = null;
    ui.profileModal.hidden = true;
    renderAll();
    toast('Profile saved.');
  }

  function updateAdminButton() {
    ui.adminBtn.hidden = !isStaff();
  }

  function applyBanState() {
    const banned = isBanned();
    const reason = state.profile && state.profile.ban_reason;

    ui.banNotice.hidden = !banned;
    ui.banNotice.textContent = banned
      ? 'Your account is banned from chatting.' + (reason ? ' Reason: ' + reason : '')
      : '';

    ui.messageInput.disabled = banned;
    ui.imageBtn.disabled = banned;
    ui.composerSubmit.disabled = banned;

    if (banned) {
      state.replyTo = null;
      renderReplyBar();
      ui.messageInput.placeholder = 'you are banned from chatting';
    } else {
      ui.messageInput.placeholder = 'type a message, /help for commands';
    }

    updateAdminButton();
  }

  function canDeleteMessage(message) {
    if (!message) return false;
    if (message.sender && message.sender === state.me.id) return true;
    return state.current && state.current.type === 'room' && isStaff();
  }

  function startReply(messageId) {
    const message = state.messages.find((item) => String(item.id) === String(messageId));
    if (!message) return;
    state.replyTo = message;
    renderReplyBar();
    ui.messageInput.focus();
  }

  function cancelReply() {
    state.replyTo = null;
    renderReplyBar();
  }

  function renderReplyBar() {
    if (!state.replyTo) {
      ui.replyBar.hidden = true;
      ui.replyText.textContent = '';
      return;
    }
    const person = state.replyTo.person;
    const who = person ? person.username : 'unknown';
    ui.replyText.textContent = 'replying to ' + who + ': ' + String(state.replyTo.body || '').slice(0, 80);
    ui.replyBar.hidden = false;
  }

  async function deleteMessage(messageId) {
    if (!state.current) return;
    const table = state.current.type === 'room' ? 'messages' : 'dm_messages';
    if (!window.confirm('Delete this message?')) return;

    const { error } = await sb.from(table).delete().eq('id', messageId);
    if (error) {
      toast(error.message);
      return;
    }
    removeMessage(messageId);
    toast('Message deleted.');
  }

  function removeMessage(messageId) {
    if (messageId === null || messageId === undefined) return;
    if (state.replyTo && String(state.replyTo.id) === String(messageId)) {
      state.replyTo = null;
      renderReplyBar();
    }
    const before = state.messages.length;
    state.messages = state.messages.filter((item) => String(item.id) !== String(messageId));
    if (state.messages.length !== before) renderMessages();
  }

  const EIGHT_BALL = [
    'It is certain.', 'Without a doubt.', 'Yes, definitely.', 'Most likely.',
    'Ask again later.', 'Cannot predict now.', 'Do not count on it.',
    'My reply is no.', 'Very doubtful.', 'Signs point to yes.'
  ];

  function rollDice(spec) {
    const match = /^(\d{0,2})d(\d{1,3})$/i.exec(spec || '');
    const count = Math.min(10, Math.max(1, parseInt((match && match[1]) || '1', 10) || 1));
    const sides = Math.min(1000, Math.max(2, parseInt((match && match[2]) || '20', 10) || 20));
    const rolls = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const value = 1 + Math.floor(Math.random() * sides);
      rolls.push(value);
      total += value;
    }
    return count > 1
      ? count + 'd' + sides + ': ' + rolls.join(' + ') + ' = ' + total
      : 'd' + sides + ': ' + total;
  }

  async function runCommand(text) {
    const trimmed = text.trim();
    if (trimmed.charAt(0) !== '/') return false;

    const space = trimmed.indexOf(' ');
    const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
    const rest = space === -1 ? '' : trimmed.slice(space + 1).trim();

    if (name === 'me') {
      if (!rest) { toast('usage: /me waves hello'); return true; }
      await sendBody('* ' + state.profile.username + ' ' + rest);
      return true;
    }

    if (name === 'shrug') {
      await sendBody((rest ? rest + ' ' : '') + '¯\\_(ツ)_/¯');
      return true;
    }

    if (name === 'tableflip') { await sendBody('(╯°□°）╯︵ ┻━┻'); return true; }
    if (name === 'unflip') { await sendBody('┬─┬ノ( º _ ºノ)'); return true; }

    if (name === 'roll') {
      await sendBody('* ' + state.profile.username + ' rolled ' + rollDice(rest));
      return true;
    }

    if (name === 'coinflip') {
      await sendBody('* ' + state.profile.username + ' flipped ' +
        (Math.random() < 0.5 ? 'heads' : 'tails'));
      return true;
    }

    if (name === '8ball') {
      if (!rest) { toast('usage: /8ball will it work?'); return true; }
      await sendBody('* 8-ball says: ' + EIGHT_BALL[Math.floor(Math.random() * EIGHT_BALL.length)]);
      return true;
    }

    if (name === 'help') {
      toast('/me /shrug /tableflip /unflip /roll /coinflip /8ball /help' +
        (isStaff() ? ' /purge /topic' : '') +
        (isAdmin() ? ' /announce /ban /unban' : ''));
      return true;
    }

    if (name === 'ban') {
      if (!isAdmin()) { toast('Admins only.'); return true; }
      const bits = rest.split(/\s+/).filter(Boolean);
      const target = bits.shift();
      if (!target) { toast('usage: /ban username reason'); return true; }
      const reason = bits.join(' ');
      if (!window.confirm('Ban ' + target + '?')) return true;
      const { error } = await sb.rpc('ban_user', {
        p_username: target,
        p_reason: reason
      });
      if (error) { toast(error.message); return true; }
      toast(target + ' banned.');
      await loadAdminUsers();
      return true;
    }

    if (name === 'unban') {
      if (!isAdmin()) { toast('Admins only.'); return true; }
      if (!rest) { toast('usage: /unban username'); return true; }
      const { error } = await sb.rpc('unban_user', { p_username: rest });
      if (error) { toast(error.message); return true; }
      toast(rest + ' unbanned.');
      await loadAdminUsers();
      return true;
    }

    if (name === 'purge') {
      if (!isStaff()) { toast('Staff only.'); return true; }
      if (!state.current || state.current.type !== 'room') { toast('Open a room first.'); return true; }
      const count = Math.min(100, Math.max(1, parseInt(rest, 10) || 10));
      if (!window.confirm('Delete the last ' + count + ' messages in this room?')) return true;
      const { data, error } = await sb.rpc('purge_room', {
        p_room: state.current.id,
        p_count: count
      });
      if (error) { toast(error.message); return true; }
      toast('Deleted ' + (data === null ? count : data) + ' messages.');
      await loadRoomMessages(state.current.id);
      renderMessages(true);
      return true;
    }

    if (name === 'topic') {
      if (!state.current || state.current.type !== 'room') { toast('Open a room first.'); return true; }
      const room = state.current.room;
      if (!isStaff() && room.owner !== state.me.id) { toast('Not allowed.'); return true; }
      const { error } = await sb.rpc('set_room_topic', {
        p_room: room.id,
        p_topic: rest
      });
      if (error) { toast(error.message); return true; }
      room.topic = rest;
      renderHeader();
      toast('Topic updated.');
      return true;
    }

    if (name === 'announce') {
      if (!isAdmin()) { toast('Admins only.'); return true; }
      if (!rest) { toast('usage: /announce hello everyone'); return true; }
      if (!state.current || state.current.type !== 'room') { toast('Open a room first.'); return true; }
      const { error } = await sb.rpc('announce', {
        p_room: state.current.id,
        p_text: rest
      });
      if (error) { toast(error.message); return true; }
      return true;
    }

    toast('Unknown command: /' + name);
    return true;
  }

  async function runFunCommand(kind) {
    const map = {
      '8ball': '/8ball will it work?',
      coinflip: '/coinflip',
      roll: '/roll d20',
      tableflip: '/tableflip',
      unflip: '/unflip'
    };
    const command = map[kind];
    if (command) await runCommand(command);
  }

  function openAdminPanel() {
    if (!isStaff()) {
      toast('Staff only.');
      return;
    }
    ui.adminModal.hidden = false;
    ui.adminAnnounce.value = '';
    renderAdminPanel();
    loadAdminUsers();
  }

  function closeAdminPanel() {
    ui.adminModal.hidden = true;
  }

  async function loadAdminUsers() {
    const { data, error } = await sb
      .from('profiles')
      .select('id, username, display_name, rank, color, avatar_url, banned, ban_reason')
      .order('username', { ascending: true })
      .limit(200);

    if (error) {
      toast(error.message);
      return;
    }
    state.adminUsers = data || [];
    for (const person of state.adminUsers) {
      state.people.set(person.id, Object.assign({}, state.people.get(person.id) || {}, person));
    }
    renderAdminUsers();
  }

  function renderAdminPanel() {
    renderAdminUsers();
    renderAdminRooms();
    const inRoom = Boolean(state.current && state.current.type === 'room');
    ui.adminAnnounceBtn.disabled = !inRoom || !isAdmin();
    ui.adminAnnounce.disabled = !isAdmin();
  }

  function renderAdminUsers() {
    ui.adminUsers.replaceChildren();

    if (!state.adminUsers.length) {
      ui.adminUsers.append(h('div', { class: 'muted tiny-pad', text: 'no users loaded' }));
      return;
    }

    const allowed = canManageRanks();
    const myRank = rankOf(state.profile);
    const ranks = ['owner', 'co-owner', 'admin', 'mod', 'member'];

    for (const person of state.adminUsers) {
      const select = h('select', { class: 'rank-select', 'data-rank-user': person.id });
      for (const rank of ranks) {
        const blocked = myRank === 'co-owner' && (rank === 'owner' || rank === 'co-owner');
        select.append(h('option', {
          value: rank,
          text: rank,
          selected: rankOf(person) === rank ? 'selected' : null,
          disabled: blocked ? 'disabled' : null
        }));
      }
      select.disabled = !allowed || person.id === state.me.id;

      const row = h('div', { class: 'admin-user' },
        avatarNode(person, 'tiny'),
        h('span', { class: 'admin-name', text: person.username }),
        rankBadge(person),
        person.banned ? h('span', { class: 'ban-mark', text: 'banned' }) : null,
        select
      );

      const targetRank = rankOf(person);
      const canBanTarget = isAdmin() &&
        person.id !== state.me.id &&
        targetRank !== 'owner' &&
        targetRank !== 'co-owner' &&
        !(targetRank === 'admin' && myRank !== 'owner' && myRank !== 'co-owner');

      if (canBanTarget) {
        row.append(h('button', {
          type: 'button',
          class: 'btn micro' + (person.banned ? '' : ' danger'),
          'data-ban-user': person.username,
          text: person.banned ? 'unban' : 'ban'
        }));
      }

      ui.adminUsers.append(row);
    }
  }

  function renderAdminRooms() {
    ui.adminRooms.replaceChildren();

    const rooms = state.rooms.filter((room) => !room.is_private || state.myRoomIds.has(room.id));
    if (!rooms.length) {
      ui.adminRooms.append(h('div', { class: 'muted tiny-pad', text: 'no rooms' }));
      return;
    }

    for (const room of rooms) {
      const row = h('div', { class: 'admin-room' },
        h('span', { class: 'admin-name', text: (room.is_private ? '*' : '#') + ' ' + room.name }),
        h('span', { class: 'muted tiny-pad', text: room.topic || '' })
      );
      if (isAdmin()) {
        row.append(h('button', {
          type: 'button',
          class: 'btn micro danger',
          'data-admin-room': room.id,
          text: 'delete'
        }));
      }
      ui.adminRooms.append(row);
    }
  }

  async function changeRank(userId, rank) {
    const { error } = await sb.rpc('set_rank', { p_user: userId, p_rank: rank });
    if (error) {
      toast(error.message);
      await loadAdminUsers();
      return;
    }
    toast('Rank updated.');
    await loadAdminUsers();
    await loadFriends();
    if (state.current && state.current.type === 'room') {
      await loadMembers(state.current.id);
    }
    renderAll();
  }

  async function banUser(username) {
    const reason = window.prompt('Reason for banning ' + username + '?', '');
    if (reason === null) return;

    const { error } = await sb.rpc('ban_user', {
      p_username: username,
      p_reason: reason
    });
    if (error) {
      toast(error.message);
      return;
    }
    toast(username + ' banned.');
    await loadAdminUsers();
  }

  async function unbanUser(username) {
    const { error } = await sb.rpc('unban_user', { p_username: username });
    if (error) {
      toast(error.message);
      return;
    }
    toast(username + ' unbanned.');
    await loadAdminUsers();
  }

  async function adminDeleteRoom(roomId) {
    if (!window.confirm('Delete this room and all of its messages?')) return;
    const { error } = await sb.rpc('admin_delete_room', { p_room: roomId });
    if (error) {
      toast(error.message);
      return;
    }
    await loadRooms();
    renderRooms();
    renderAdminRooms();

    if (state.current && state.current.type === 'room' && state.current.id === roomId) {
      state.current = null;
      state.messages = [];
      state.members = [];
      state.replyTo = null;
      renderReplyBar();
      renderHeader();
      renderMessages();
      renderMembers();
    }

    toast('Room deleted.');
  }

  async function sendAnnouncement() {
    if (!state.current || state.current.type !== 'room') {
      toast('Open a room first.');
      return;
    }
    const text = ui.adminAnnounce.value.trim();
    if (!text) return;

    const { error } = await sb.rpc('announce', { p_room: state.current.id, p_text: text });
    if (error) {
      toast(error.message);
      return;
    }
    ui.adminAnnounce.value = '';
    toast('Announcement sent.');
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard.');
    } catch (_) {
      window.prompt('Copy this:', text);
    }
  }

  init();

})();
