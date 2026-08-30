/* シフト管理の管理画面。ビルド不要の素の JavaScript で動かす。 */
(function () {
  'use strict';

  var TOKEN_KEY = 'shift-admin-token';
  var WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

  var board = null;        // サーバーから取得した一式
  var assignments = [];    // 編集中の割当（保存するまでサーバーには反映されない）
  var dirty = false;

  var el = {
    token: document.getElementById('token'),
    saveToken: document.getElementById('save-token'),
    period: document.getElementById('period'),
    periodStatus: document.getElementById('period-status'),
    reload: document.getElementById('reload'),
    auto: document.getElementById('auto'),
    save: document.getElementById('save'),
    publish: document.getElementById('publish'),
    create: document.getElementById('create'),
    message: document.getElementById('message'),
    issues: document.getElementById('issues'),
    issueCount: document.getElementById('issue-count'),
    boardTable: document.getElementById('board'),
    summary: document.getElementById('summary'),
  };

  // ----------------------------------------------------------
  // 通信
  // ----------------------------------------------------------
  function token() {
    return el.token.value.trim();
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { 'x-admin-token': token() };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function message(text, kind) {
    el.message.textContent = text;
    el.message.className = 'message ' + (kind || 'ok');
    el.message.hidden = !text;
  }

  function busy(on) {
    [el.auto, el.save, el.publish, el.reload, el.create].forEach(function (b) { b.disabled = on; });
  }

  // ----------------------------------------------------------
  // 読み込み
  // ----------------------------------------------------------
  function loadPeriods() {
    return api('/periods').then(function (data) {
      el.period.innerHTML = '';
      data.periods.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id;
        o.textContent = '#' + p.id + ' ' + p.name + '（' + p.start_date + '〜' + p.end_date + '）';
        el.period.appendChild(o);
      });
      if (data.periods.length === 0) {
        message('シフト期間がありません。「新しい期間を作る」から作成してください。', 'err');
        return null;
      }
      return loadBoard(el.period.value);
    });
  }

  function loadBoard(periodId) {
    if (!periodId) return Promise.resolve();
    return api('/periods/' + periodId + '/board').then(function (data) {
      board = data;
      assignments = data.assignments.map(function (a) {
        return {
          date: a.date,
          shift_type_id: a.shift_type_id,
          staff_id: a.staff_id,
          locked: !!a.locked,
          status: a.status,
        };
      });
      dirty = false;
      render();
      renderIssues(data.issues);
      el.periodStatus.textContent = '状態: ' + statusLabel(data.period.status)
        + '　提出: ' + data.submitted_staff_ids.length + '/' + data.staff.length + '名'
        + (data.period.request_deadline ? '　締切: ' + data.period.request_deadline : '');
    });
  }

  function statusLabel(status) {
    return ({
      draft: '下書き', collecting: '希望受付中', assigned: '割当済み（未公開）',
      published: '公開済み', closed: '締め',
    })[status] || status;
  }

  // ----------------------------------------------------------
  // 描画
  // ----------------------------------------------------------
  function indexOfSlots() {
    var map = {};
    board.slots.forEach(function (s) { map[s.date + '|' + s.shiftTypeId] = s; });
    return map;
  }

  function staffById(id) {
    for (var i = 0; i < board.staff.length; i++) {
      if (board.staff[i].id === id) return board.staff[i];
    }
    return null;
  }

  function preferenceOf(staffId, date) {
    for (var i = 0; i < board.requests.length; i++) {
      var r = board.requests[i];
      if (r.staff_id === staffId && r.date === date) return r.preference;
    }
    return 'ok';
  }

  function assignedOn(date) {
    return assignments.filter(function (a) { return a.date === date; });
  }

  function render() {
    if (!board) return;
    var slots = indexOfSlots();
    var holidays = {};
    board.holidays.forEach(function (h) { holidays[h.date] = h.name || '休診'; });

    var thead = '<thead><tr><th>日付</th>'
      + board.shiftTypes.map(function (t) {
        return '<th>' + escapeHtml(t.name) + '<br><span class="muted small">'
          + t.start_time.slice(0, 5) + '-' + t.end_time.slice(0, 5) + '</span></th>';
      }).join('')
      + '<th>希望</th></tr></thead>';

    var rows = board.dates.map(function (date) {
      var dow = new Date(date + 'T00:00:00Z').getUTCDay();
      var cls = 'date' + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '') + (holidays[date] ? ' holiday' : '');
      var label = Number(date.slice(5, 7)) + '/' + Number(date.slice(8, 10)) + '(' + WEEKDAY[dow] + ')';
      var cells = board.shiftTypes.map(function (t) {
        return renderCell(date, t, slots[date + '|' + t.id]);
      }).join('');
      return '<tr><td class="' + cls + '">' + label
        + (holidays[date] ? '<br><span class="small">' + escapeHtml(holidays[date]) + '</span>' : '')
        + '</td>' + cells + '<td class="wish">' + renderWishes(date) + '</td></tr>';
    }).join('');

    el.boardTable.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    bindCellEvents();
    renderSummary();
  }

  function renderCell(date, type, slot) {
    var rows = assignments.filter(function (a) {
      return a.date === date && a.shift_type_id === type.id;
    });

    var need = '';
    if (slot) {
      var extra = slot.minima.map(function (m) { return m.qualification + m.count; }).join(' ');
      var shortage = rows.length < slot.total;
      need = '<span class="need' + (shortage ? ' short' : '') + '">必要 ' + rows.length + '/' + slot.total + '名'
        + (extra ? '（' + escapeHtml(extra) + '）' : '') + '</span>';
    } else if (rows.length > 0) {
      need = '<span class="need short">募集なしの枠</span>';
    }

    var chips = rows.map(function (a) {
      var member = staffById(a.staff_id);
      var name = member ? member.name : '#' + a.staff_id;
      var ng = preferenceOf(a.staff_id, date) === 'ng';
      var classes = 'chip' + (a.locked ? ' locked' : '') + (ng ? ' ng' : '');
      var display = a.status === 'absent' ? '<s>' + escapeHtml(name) + '</s>' : escapeHtml(name);
      return '<span class="' + classes + '">' + display
        + '<button data-act="lock" data-date="' + date + '" data-type="' + type.id + '" data-staff="' + a.staff_id
        + '" title="自動割当から保護">' + (a.locked ? '📌' : '📍') + '</button>'
        + '<button data-act="remove" data-date="' + date + '" data-type="' + type.id + '" data-staff="' + a.staff_id
        + '" title="外す">×</button></span>';
    }).join('');

    var taken = {};
    assignedOn(date).forEach(function (a) { taken[a.staff_id] = true; });
    var options = ['<option value="">＋ 追加</option>'].concat(board.staff.map(function (s) {
      if (taken[s.id]) return '';
      var pref = preferenceOf(s.id, date);
      var mark = pref === 'want' ? '◎ ' : pref === 'ng' ? '× ' : '';
      return '<option value="' + s.id + '">' + mark + escapeHtml(s.name) + '</option>';
    })).join('');

    return '<td class="slot">' + need + chips
      + '<select class="add" data-date="' + date + '" data-type="' + type.id + '">' + options + '</select></td>';
  }

  function renderWishes(date) {
    var want = [];
    var ng = [];
    board.requests.forEach(function (r) {
      if (r.date !== date) return;
      var member = staffById(r.staff_id);
      if (!member) return;
      if (r.preference === 'want') want.push(member.name);
      if (r.preference === 'ng') ng.push(member.name);
    });
    var out = [];
    if (want.length) out.push('◎ ' + escapeHtml(want.join('、')));
    if (ng.length) out.push('× ' + escapeHtml(ng.join('、')));
    return out.join('<br>') || '<span class="muted">—</span>';
  }

  function renderSummary() {
    var head = '<thead><tr><th>スタッフ</th><th>勤務日数</th><th>希望の反映</th><th>不可日</th><th>提出</th></tr></thead>';
    var submitted = {};
    board.submitted_staff_ids.forEach(function (id) { submitted[id] = true; });

    var rows = board.staff.map(function (s) {
      var days = 0;
      var wantTotal = 0;
      var wantHonored = 0;
      var ngDays = 0;
      var mine = {};
      assignments.forEach(function (a) { if (a.staff_id === s.id) mine[a.date] = true; });
      days = Object.keys(mine).length;
      board.requests.forEach(function (r) {
        if (r.staff_id !== s.id) return;
        if (r.preference === 'want') {
          wantTotal++;
          if (mine[r.date]) wantHonored++;
        }
        if (r.preference === 'ng') ngDays++;
      });
      return '<tr><td>' + escapeHtml(s.name) + '</td><td>' + days + '日</td>'
        + '<td>' + (wantTotal ? wantHonored + '/' + wantTotal + '日' : '—') + '</td>'
        + '<td>' + ngDays + '日</td>'
        + '<td>' + (submitted[s.id] ? '✅' : '<span class="muted">未提出</span>') + '</td></tr>';
    }).join('');

    el.summary.innerHTML = head + '<tbody>' + rows + '</tbody>';
  }

  function renderIssues(issues) {
    el.issueCount.textContent = issues.length;
    if (issues.length === 0) {
      el.issues.innerHTML = '<li class="muted">問題は見つかりませんでした。</li>';
      return;
    }
    el.issues.innerHTML = issues.map(function (i) {
      return '<li class="' + i.level + '"><span class="lv">' + (i.level === 'error' ? '要修正' : '注意')
        + '</span>' + escapeHtml(i.date || '') + ' ' + escapeHtml(i.message) + '</li>';
    }).join('');
  }

  function bindCellEvents() {
    el.boardTable.querySelectorAll('select.add').forEach(function (sel) {
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        assignments.push({
          date: sel.dataset.date,
          shift_type_id: Number(sel.dataset.type),
          staff_id: Number(sel.value),
          locked: true,   // 手で入れた枠は自動割当で消えないよう保護する
          status: 'assigned',
        });
        dirty = true;
        render();
      });
    });

    el.boardTable.querySelectorAll('.chip button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var d = btn.dataset;
        var index = assignments.findIndex(function (a) {
          return a.date === d.date && a.shift_type_id === Number(d.type) && a.staff_id === Number(d.staff);
        });
        if (index < 0) return;
        if (d.act === 'remove') assignments.splice(index, 1);
        else assignments[index].locked = !assignments[index].locked;
        dirty = true;
        render();
      });
    });
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ----------------------------------------------------------
  // 操作
  // ----------------------------------------------------------
  el.saveToken.addEventListener('click', function () {
    localStorage.setItem(TOKEN_KEY, token());
    message('トークンをこのブラウザに保存しました。');
    loadPeriods().catch(function (e) { message(e.message, 'err'); });
  });

  el.period.addEventListener('change', function () {
    if (dirty && !confirm('保存していない変更があります。破棄して切り替えますか？')) return;
    loadBoard(el.period.value).catch(function (e) { message(e.message, 'err'); });
  });

  el.reload.addEventListener('click', function () {
    if (dirty && !confirm('保存していない変更があります。破棄して再読込しますか？')) return;
    loadBoard(el.period.value).catch(function (e) { message(e.message, 'err'); });
  });

  el.auto.addEventListener('click', function () {
    if (!confirm('自動割当を実行します。📌 で保護していない割当は置き換えられます。よろしいですか？')) return;
    busy(true);
    api('/periods/' + el.period.value + '/auto-assign', { method: 'POST' })
      .then(function (result) {
        var text = '自動割当が完了しました（' + result.assignments.length + '件）。';
        if (result.unfilled.length) text += ' 埋まらない枠: ' + result.unfilled.length + '件。';
        message(text, result.unfilled.length ? 'err' : 'ok');
        return loadBoard(el.period.value);
      })
      .catch(function (e) { message(e.message, 'err'); })
      .then(function () { busy(false); });
  });

  el.save.addEventListener('click', function () {
    busy(true);
    api('/periods/' + el.period.value + '/assignments', {
      method: 'PUT',
      body: { assignments: assignments },
    })
      .then(function (result) {
        message('保存しました（' + result.saved + '件）。');
        return loadBoard(el.period.value);
      })
      .catch(function (e) { message(e.message, 'err'); })
      .then(function () { busy(false); });
  });

  el.publish.addEventListener('click', function () {
    if (dirty) {
      message('未保存の変更があります。先に保存してください。', 'err');
      return;
    }
    if (!confirm('このシフトを公開し、Slack のチャンネル投稿と各自への DM を送ります。よろしいですか？')) return;
    busy(true);
    api('/periods/' + el.period.value + '/publish', { method: 'POST', body: { dm: true } })
      .then(function (result) {
        message('公開しました（DM ' + result.dmSent + '名'
          + (result.dmFailed.length ? ' / 失敗 ' + result.dmFailed.length + '名' : '') + '）。');
        return loadBoard(el.period.value);
      })
      .catch(function (e) { message(e.message, 'err'); })
      .then(function () { busy(false); });
  });

  el.create.addEventListener('click', function () {
    var body = {
      name: document.getElementById('new-name').value.trim(),
      start_date: document.getElementById('new-start').value,
      end_date: document.getElementById('new-end').value,
      request_deadline: document.getElementById('new-deadline').value || null,
    };
    if (!body.name || !body.start_date || !body.end_date) {
      message('名前・開始日・終了日を入力してください。', 'err');
      return;
    }
    busy(true);
    api('/periods', { method: 'POST', body: body })
      .then(function () {
        message('期間を作成しました。Slack の `/shift-admin open <期間ID>` で希望受付を開始できます。');
        return loadPeriods();
      })
      .catch(function (e) { message(e.message, 'err'); })
      .then(function () { busy(false); });
  });

  window.addEventListener('beforeunload', function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // 起動
  el.token.value = localStorage.getItem(TOKEN_KEY) || '';
  if (el.token.value) {
    loadPeriods().catch(function (e) { message(e.message, 'err'); });
  } else {
    message('管理トークンを入力して「記憶」を押してください。', 'err');
  }
}());
