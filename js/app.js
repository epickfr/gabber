/* ============================================================
   EPICK CHAT — old-school chat client
   Vanilla JS + Supabase (auth, Postgres, Realtime)
   ============================================================ */
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

  // ---------- tiny helpers ----------
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

  const fmtTime = (iso) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const initial = (name) => (name || '?').slice(0, 1).toUpperCase();

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

  // ---------- state ----------
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
      toastTimer: null
    };
  }
  let state = freshState();

  // ---------- dom ----------
  const ui = {
    app: $id('app-window'),
    auth: $id('auth-overlay'),
    authMain: $id('auth-main'),
    setupPanel: $id('setup-panel'),
    authTabs: $id('auth-tabs'),
    loginForm: $id('login-form'),
    registerForm: $id('register-form'),
    loginEmail: $id('login-email'),
    loginPassword: $id('login-password'),
    registerUsername: $id('register-username'),
    registerDisplay: $id('register-display'),
    registerEmail: $id('register-email'),
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
    toast: $id('toast')
  };

  // ---------- auth error helpers ----------
  function setAuthError(message, kind) {
    ui.authError.textContent = message || '';
    ui.authError.hidden = !message;
    ui.authError.className = 'auth-error' + (kind === 'ok' ? ' ok' : '');
  }

  function friendlyAuthError(error) {
    const message = (error && error.message) || 'Something went wrong.';
    if (/invalid login credentials/i.test(message)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(message)) return 'Confirm your email first, then sign in.';
    if (/user already registered/i.test(message)) return 'That email is already registered. Try signing in.';
    if (/password should be at least/i.test(message)) return 'Password must be at least 6 characters.';
    if (/username is already taken/i.test(message)) return 'That username is already taken.';
    if (/rate limit/i.test(message)) return 'Too many attempts. Wait a minute and try again.';
    return message;
  }

  function setBusy(form, busy) {
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = busy;
  }

  // ---------- toast ----------
  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3200);
  }

  // ---------- boot ----------
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
      try { await sb.auth.signOut(); } catch (_) { /* ignore */ }
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
    ui.messages.replaceChildren();
    ui.memberList.replaceChildren();
    ui.friends.replaceChildren();
    ui.myRooms.replaceChildren();
    ui.publicRooms.replaceChildren();
    ui.friendRequests.replaceChildren();
    ui.friendResults.replaceChildren();
    ui.channelName.textContent = '—';
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

    // Trigger normally creates the profile. This is a fallback.
    const meta = state.me.user_metadata || {};
    let base = String(meta.username || (state.me.email || 'user').split('@')[0])
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

  // ---------- auth events ----------
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
      const { error } = await sb.auth.signInWithPassword({
        email: ui.loginEmail.value.trim(),
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
      const email = ui.registerEmail.value.trim();
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

      // Friendly pre-check so a taken username doesn't surface as a generic DB error.
      const { data: available, error: checkError } = await sb.rpc('username_available', {
        p_username: username
      });

      if (!checkError && available === false) {
        setBusy(ui.registerForm, false);
        setAuthError('That username is already taken. Try another one.');
        return;
      }

      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
          data: { username, display_name: displayName || username },
          emailRedirectTo: window.location.origin + window.location.pathname
        }
      });

      setBusy(ui.registerForm, false);
      if (error) {
        setAuthError(friendlyAuthError(error));
        return;
      }

      if (!data.session) {
        setAuthError('Account created! Check your email to confirm it, then sign in.', 'ok');
        ui.registerForm.reset();
      } else {
        startApp(data.session);
      }
    });
  }

  // ---------- app events ----------
  function bindApp() {
    ui.logoutBtn.addEventListener('click', async () => {
      await sb.auth.signOut();
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

  // ---------- data loading ----------
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

  // ---------- rendering ----------
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

  function renderMe() {
    if (!state.profile) {
      ui.sidebarMe.replaceChildren();
      return;
    }
    const person = state.profile;
    ui.sidebarMe.replaceChildren(
      h('span', { class: 'avatar', style: 'background-color:' + person.color }, initial(person.username)),
      h('span', { class: 'me-text' },
        h('strong', { text: person.username }),
        h('br'),
        h('small', { text: person.display_name || 'online now' })
      )
    );
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
    const person = message.person || { username: 'unknown', color: '#000000' };
    return h('div', { class: 'msg' + (message.sender === state.me.id ? ' mine' : '') },
      h('span', { class: 'ts', text: '[' + fmtTime(message.created_at) + '] ' }),
      h('span', { class: 'nick', style: 'color:' + (person.color || '#000000'), text: '<' + person.username + '> ' }),
      h('span', { class: 'body', text: message.body })
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
      ui.userlistTitle.textContent = 'DIRECT MESSAGE';
      const person = current.person;
      const online = state.online.has(person.id);
      ui.memberList.append(
        h('div', { class: 'profile-card' },
          h('span', { class: 'avatar big', style: 'background-color:' + person.color }, initial(person.username)),
          h('div', { class: 'profile-name', text: person.username }),
          h('div', { class: 'profile-sub', text: person.display_name || '' }),
          h('div', { class: 'presence ' + (online ? 'on' : 'off'), text: online ? '* online *' : 'offline' })
        )
      );
      return;
    }

    ui.userlistTitle.textContent = 'IN THIS ROOM (' + state.members.length + ')';

    const sorted = [...state.members].sort((a, b) => {
      const aOnline = state.online.has(a.id) ? 0 : 1;
      const bOnline = state.online.has(b.id) ? 0 : 1;
      if (aOnline !== bOnline) return aOnline - bOnline;
      return a.username.localeCompare(b.username);
    });

    for (const person of sorted) {
      ui.memberList.append(h('div', { class: 'member' },
        h('span', { class: 'dot' + (state.online.has(person.id) ? ' on' : '') }),
        h('span', { class: 'label', style: 'color:' + (person.color || '#000000'), text: person.username })
      ));
    }

    if (!sorted.length) ui.memberList.append(h('div', { class: 'muted tiny-pad', text: 'nobody here yet' }));
  }

  function renderStatus() {
    ui.statusOnline.textContent = state.online.size + ' online';
    ui.statusUser.textContent = state.profile ? state.profile.username : 'guest';
  }

  // ---------- conversations ----------
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
      .select('id, body, created_at, sender, person:profiles!messages_sender_fkey(username, display_name, color)')
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
      person: row.person || state.people.get(row.sender) || { username: 'unknown', color: '#000000' }
    }));
  }

  async function loadDMMessages(threadId, friendId) {
    const { data, error } = await sb
      .from('dm_messages')
      .select('id, body, created_at, sender, person:profiles!dm_messages_sender_fkey(username, display_name, color)')
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
      person: row.person || state.people.get(row.sender) || state.people.get(friendId) || { username: 'unknown', color: '#000000' }
    }));
  }

  function unsubscribeConversation() {
    if (state.convChannel) {
      try { sb.removeChannel(state.convChannel); } catch (_) { /* ignore */ }
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
      person: person || { username: 'unknown', color: '#000000' }
    };

    state.messages.push(message);
    ui.messages.append(messageNode(message));
    scrollToBottom(false);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const body = ui.messageInput.value.trim();
    if (!body || !state.current) return;
    if (body.length > 2000) {
      toast('Message is too long.');
      return;
    }

    const current = state.current;
    const table = current.type === 'room' ? 'messages' : 'dm_messages';
    const payload = current.type === 'room'
      ? { room_id: current.id, sender: state.me.id, body }
      : { thread_id: current.id, sender: state.me.id, body };

    ui.messageInput.value = '';

    const { data, error } = await sb.from(table).insert(payload).select().single();
    if (error) {
      ui.messageInput.value = body;
      toast(error.message);
      return;
    }

    if (!state.current || state.current.type !== current.type || state.current.id !== current.id) return;
    await addIncomingMessage(data);
    scrollToBottom(true);
  }

  function scrollToBottom(force) {
    const box = ui.messages;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function focusComposer() {
    if (!isMobile()) ui.messageInput.focus();
  }

  // ---------- unread badges ----------
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

  // ---------- presence ----------
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

  // ---------- global realtime ----------
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
          state.profile = person;
          renderMe();
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

  // ---------- friends ----------
  async function searchPeople(query) {
    if (!query || query.length < 2) {
      toast('Type at least 2 characters.');
      return;
    }

    const { data, error } = await sb
      .from('profiles')
      .select('id, username, display_name, color')
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

  // ---------- rooms ----------
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

  // ---------- misc ----------
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
