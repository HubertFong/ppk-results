// Kit stock on the kit page (FEAT-040 S6, #314). Anyone sees what is in
// stock and for sale ("In stock now"): sizes, never counts. A signed-in
// member buys pieces, sees their buys and how to pay, and cancels an unpaid
// one. A shop manager (or kit organiser) keeps the items, records moves
// with their reasons, and marks members' buys Paid, Collected or cancelled.
// The database decides every rule; this script only asks and shows. It
// never writes HTML.
(function () {
  "use strict";

  var PICTURE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/]+={0,2}$/;
  var REASONS = [
    ["opening_count", "Opening count", 1], ["delivery_extra", "Delivery extra", 1],
    ["swap_in", "Swap in", 1], ["reservation_ended", "Hold ended", 1],
    ["sale_on_site", "Sold on site", -1], ["sale_by_hand", "Sold by hand", -1],
    ["swap_out", "Swap out", -1], ["sample", "Sample", -1], ["damaged", "Damaged", -1],
    ["reserved", "Held for a member", -1], ["count_fix", "Count fix (+ or -)", 0]
  ];
  var MOVE_WORDS = { sale_online: "Sold on the site", sale_cancelled: "Sale cancelled" };
  REASONS.forEach(function (r) { MOVE_WORDS[r[0]] = r[1]; });
  var STATUS_WORDS = { placed: "Not paid", paid: "Paid", collected: "Collected", cancelled: "Cancelled" };

  function money(sen) {
    var whole = Math.floor(sen / 100), cents = sen % 100;
    return "RM" + whole + (cents ? "." + (cents < 10 ? "0" : "") + cents : "");
  }

  // "RM40" or "40.50" typed by the manager, in sen; null when it isn't a price.
  function sen(text) {
    var m = /^\s*(?:RM\s*)?(\d{1,6})(?:\.(\d{1,2}))?\s*$/i.exec(text || "");
    if (!m) return null;
    return parseInt(m[1], 10) * 100 + (m[2] ? parseInt((m[2] + "0").slice(0, 2), 10) : 0);
  }

  // "Name: value" lines into a details object; null when a line doesn't fit.
  function details(text) {
    var out = {};
    var lines = (text || "").split(/\r?\n/).filter(function (l) { return l.trim(); });
    for (var i = 0; i < lines.length; i++) {
      var at = lines[i].indexOf(":");
      if (at < 1) return null;
      out[lines[i].slice(0, at).trim()] = lines[i].slice(at + 1).trim();
    }
    return out;
  }

  function variant(cut, size) {
    return [cut, size].filter(function (x) { return x; }).join(" · ") || "One size";
  }

  var api = { money: money, sen: sen, details: details, variant: variant, REASONS: REASONS,
              MOVE_WORDS: MOVE_WORDS, PICTURE: PICTURE };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  var root = document.getElementById("kit-stock");
  if (!root || !window.supabase) return;
  var client = supabase.createClient(root.getAttribute("data-supabase-url"),
                                     root.getAttribute("data-supabase-key"));
  var manage = document.getElementById("kit-stock-manage");
  var user = null;

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function label(text, field) {
    var wrap = el("label", null, "kit-field");
    wrap.appendChild(el("span", text));
    wrap.appendChild(field);
    return wrap;
  }
  function button(text, className, onClick) {
    var b = el("button", text, className || "kit-btn");
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  function say(node, text, bad) {
    node.textContent = text;
    node.className = bad ? "kit-error" : "kit-help";
    node.hidden = !text;
  }
  function picture(dataUrl, alt, className) {
    if (!dataUrl || !PICTURE.test(dataUrl)) return null;
    var img = el("img", null, className);
    img.src = dataUrl;
    img.alt = alt;
    return img;
  }
  function problem(res) {
    var e = res && res.error;
    return e ? (e.message || "Something went wrong").replace(/^[a-z_]+: /, "") : "";
  }

  // ------------------------------------------------------------ members

  function showForSale() {
    client.rpc("stock_for_sale").then(function (res) {
      clear(root);
      var items = res && !res.error ? res.data || [] : [];
      if (!items.length) { root.hidden = true; return; }
      root.hidden = false;
      root.appendChild(el("h2", "In stock now", "kit-section"));
      root.appendChild(el("p", "Ready to collect, no waiting for a round.", "kit-help"));
      var list = el("div", null, "kit-cards");
      items.forEach(function (item) { list.appendChild(stockCard(item)); });
      root.appendChild(list);
      root.appendChild(mine);
      showMine();
    });
  }

  function stockCard(item) {
    var card = el("article", null, "kit-card");
    var photo = picture(item.photo, item.name, "kit-photo");
    if (photo) card.appendChild(photo);
    var head = el("div", null, "kit-head");
    head.appendChild(el("h2", item.name));
    head.appendChild(el("b", money(item.price_sen)));
    card.appendChild(head);
    if (item.blurb) card.appendChild(el("p", item.blurb, "kit-blurb"));
    var facts = [item.condition === "used" ? "Used" : "New",
                 item.category === "event_merchandise" ? "Event merchandise" : "Kit"];
    if (item.one_of_a_kind) facts.push("One of a kind");
    Object.keys(item.details || {}).forEach(function (k) { facts.push(k + ": " + item.details[k]); });
    card.appendChild(el("p", facts.join(" · "), "kit-meta"));
    card.appendChild(el("p", "Sold by " + item.seller + (/\.$/.test(item.seller) ? "" : "."), "kit-meta"));
    var slot = el("div");
    card.appendChild(slot);
    if (!user) {
      var link = el("a", "Sign in to buy");
      link.href = "account.html";
      slot.appendChild(link);
      return card;
    }
    var form = el("form", null, "kit-form");
    var which = el("select");
    item.sizes.forEach(function (s, i) { which.appendChild(new Option(variant(s.cut, s.size), String(i))); });
    form.appendChild(label("Size", which));
    var qty = el("select");
    for (var n = 1; n <= (item.one_of_a_kind ? 1 : 5); n++) qty.appendChild(new Option(String(n), String(n)));
    form.appendChild(label("Quantity", qty));
    var buy = el("button", "Buy", "kit-btn");
    buy.type = "submit";
    form.appendChild(buy);
    var note = el("p");
    note.hidden = true;
    form.appendChild(note);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var s = item.sizes[parseInt(which.value, 10)];
      buy.disabled = true;
      client.rpc("stock_buy", { p_item: item.code, p_cut: s.cut, p_size: s.size,
                                p_quantity: parseInt(qty.value, 10) }).then(function (res) {
        buy.disabled = false;
        if (res.error) { say(note, problem(res), true); return; }
        say(note, res.data.number + " placed: " + money(res.data.total_sen) + " to pay. How to pay is below.");
        showMine();
      });
    });
    slot.appendChild(form);
    return card;
  }

  var mine = el("div");
  function showMine() {
    clear(mine);
    if (!user) return;
    client.rpc("stock_for_member").then(function (res) {
      clear(mine);
      var data = res && !res.error ? res.data : null;
      if (!data || !data.sales.length) return;
      mine.appendChild(el("h3", "Your in-stock buys"));
      var list = el("ul", null, "kit-mine-list");
      data.sales.forEach(function (s) {
        var li = el("li");
        li.appendChild(el("b", s.number + " · " + STATUS_WORDS[s.status]));
        li.appendChild(el("div", s.name + " · " + variant(s.cut, s.size) + " · " + s.quantity + " · " +
                                 money(s.total_sen)));
        if (s.status === "placed") {
          li.appendChild(button("Cancel", "kit-btn kit-btn--small kit-btn--secondary", function () {
            client.rpc("stock_cancel_sale", { p_sale: s.id }).then(function () { refresh(); });
          }));
        }
        list.appendChild(li);
      });
      mine.appendChild(list);
      if (data.payment_note) mine.appendChild(el("p", data.payment_note, "kit-pay"));
      var qr = picture(data.payment_qr, "DuitNow QR", "kit-qr");
      if (qr) mine.appendChild(qr);
      mine.appendChild(el("p", "Pay the amount, then the shop marks it Paid. Collect at a Saturday ride.", "kit-help"));
    });
  }

  // ------------------------------------------------------------ the manager

  function showManage() {
    if (!manage || !user) { if (manage) manage.hidden = true; return; }
    client.rpc("stock_levels").then(function (res) {
      if (res.error) { manage.hidden = true; return; }
      clear(manage);
      manage.hidden = false;
      manage.appendChild(el("h2", "Stock", "kit-section"));
      var rows = res.data || [];
      manage.appendChild(levelsTable(rows));
      var items = [];
      rows.forEach(function (r) { if (items.indexOf(r.code) < 0) items.push(r.code); });
      manage.appendChild(moveForm(items, rows));
      manage.appendChild(itemForm(rows));
      var sales = el("div");
      manage.appendChild(sales);
      showSales(sales);
    });
  }

  function levelsTable(rows) {
    var table = el("table", null, "kit-orders-table");
    var head = el("tr");
    ["Item", "Size", "On hand", "Held", "Not paid", ""].forEach(function (h) { head.appendChild(el("th", h)); });
    table.appendChild(head);
    rows.forEach(function (r) {
      var tr = el("tr");
      var name = r.name + (r.condition === "used" ? " (used)" : "") + (r.for_sale ? " · " + money(r.price_sen) : " · not for sale");
      [name, r.cut == null ? "-" : variant(r.cut, r.size), String(r.on_hand), String(r.held), String(r.unpaid)]
        .forEach(function (c) { tr.appendChild(el("td", c)); });
      var td = el("td");
      td.appendChild(button("Moves", "kit-btn kit-btn--small kit-btn--secondary", function () { showMoves(r, tr); }));
      tr.appendChild(td);
      table.appendChild(tr);
    });
    var box = el("div");
    box.appendChild(table);
    return box;
  }

  // A second click on Moves closes the list.
  function showMoves(r, tr) {
    var next = tr.nextSibling;
    if (next && next.className === "kit-moves") { next.parentNode.removeChild(next); return; }
    client.rpc("stock_moves_for", { p_item: r.code }).then(function (res) {
      var row = el("tr", null, "kit-moves");
      var td = el("td");
      td.colSpan = 6;
      var list = el("ul", null, "kit-log");
      (res.data || []).forEach(function (m) {
        list.appendChild(el("li", new Date(m.moved_at).toLocaleString("en-MY") + " · " + variant(m.cut, m.size) +
                                  " · " + (m.quantity > 0 ? "+" : "") + m.quantity + " · " +
                                  (MOVE_WORDS[m.reason] || m.reason) + (m.note ? " · " + m.note : "") +
                                  (m.sale_number ? " · " + m.sale_number : "")));
      });
      td.appendChild(list);
      row.appendChild(td);
      tr.parentNode.insertBefore(row, tr.nextSibling);
    });
  }

  function moveForm(items, rows) {
    var form = el("form", null, "kit-form kit-basket");
    form.appendChild(el("b", "Record a move"));
    var item = el("select");
    items.forEach(function (code) {
      var r = rows.filter(function (x) { return x.code === code; })[0];
      item.appendChild(new Option(r.name, code));
    });
    form.appendChild(label("Item", item));
    var cut = el("input");
    form.appendChild(label("Cut (blank for none)", cut));
    var size = el("input");
    form.appendChild(label("Size (blank for one size)", size));
    var qty = el("input");
    qty.type = "number";
    qty.value = "1";
    form.appendChild(label("Pieces", qty));
    var reason = el("select");
    REASONS.forEach(function (r) { reason.appendChild(new Option(r[1], r[0])); });
    form.appendChild(label("Reason", reason));
    var note = el("input");
    note.maxLength = 200;
    form.appendChild(label("Note (who it is held for, or why the count changed)", note));
    var save = el("button", "Record", "kit-btn");
    save.type = "submit";
    form.appendChild(save);
    var said = el("p");
    said.hidden = true;
    form.appendChild(said);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      client.rpc("stock_move", { p_item: item.value, p_cut: cut.value, p_size: size.value,
                                 p_quantity: parseInt(qty.value, 10), p_reason: reason.value,
                                 p_note: note.value }).then(function (res) {
        if (res.error) { say(said, problem(res), true); return; }
        showManage();
      });
    });
    return form;
  }

  function itemForm(rows) {
    var form = el("form", null, "kit-form kit-basket");
    form.appendChild(el("b", "Add or change an item"));
    form.appendChild(el("p", "Same code changes the item. A photo kept stays unless you pick a new one.", "kit-help"));
    var fields = {};
    [["code", "Code (lower-case words with hyphens, such as 3-peaks-tee)"], ["name", "Name"],
     ["blurb", "One line about it"], ["seller", "Seller (blank for BND Global Management Sdn. Bhd.)"],
     ["price", "Price (RM, blank if not for sale)"]].forEach(function (f) {
      fields[f[0]] = el("input");
      form.appendChild(label(f[1], fields[f[0]]));
    });
    var category = el("select");
    [["kit", "Kit"], ["event_merchandise", "Event merchandise"]].forEach(function (c) {
      category.appendChild(new Option(c[1], c[0]));
    });
    form.appendChild(label("Category", category));
    var condition = el("select");
    [["new", "New"], ["used", "Used"]].forEach(function (c) { condition.appendChild(new Option(c[1], c[0])); });
    form.appendChild(label("Condition", condition));
    var forSale = el("input");
    forSale.type = "checkbox";
    form.appendChild(label("For sale", forSale));
    var single = el("input");
    single.type = "checkbox";
    form.appendChild(label("One of a kind", single));
    var facts = el("textarea");
    facts.rows = 3;
    form.appendChild(label("Details, one per line (Colour: Navy)", facts));
    var photo = el("input");
    photo.type = "file";
    photo.accept = "image/png,image/jpeg,image/webp";
    form.appendChild(label("Photo", photo));
    var save = el("button", "Save item", "kit-btn");
    save.type = "submit";
    form.appendChild(save);
    var said = el("p");
    said.hidden = true;
    form.appendChild(said);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var item = { code: fields.code.value.trim(), name: fields.name.value.trim(), blurb: fields.blurb.value,
                   seller: fields.seller.value, category: category.value, condition: condition.value,
                   for_sale: forSale.checked, one_of_a_kind: single.checked };
      var price = fields.price.value.trim();
      item.price_sen = price ? sen(price) : null;
      if (price && item.price_sen == null) { say(said, "The price is a number of ringgit, such as 40 or 40.50.", true); return; }
      item.details = details(facts.value);
      if (!item.details) { say(said, "Write each detail as Name: value.", true); return; }
      var send = function () {
        client.rpc("stock_save_item", { p_item: item }).then(function (res) {
          if (res.error) { say(said, problem(res), true); return; }
          showManage();
          showForSale();
        });
      };
      if (!photo.files || !photo.files[0]) { send(); return; }
      shrink(photo.files[0], function (url) {
        if (!url) { say(said, "That photo couldn't be read.", true); return; }
        item.photo = url;
        send();
      });
    });
    return form;
  }

  // A photo at most 600 px on its long side, as JPEG, so it stays small.
  function shrink(file, done) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 600 / Math.max(img.width, img.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        var url = canvas.toDataURL("image/jpeg", 0.85);
        done(PICTURE.test(url) ? url : null);
      };
      img.onerror = function () { done(null); };
      img.src = reader.result;
    };
    reader.onerror = function () { done(null); };
    reader.readAsDataURL(file);
  }

  function showSales(box) {
    client.rpc("stock_sales").then(function (res) {
      clear(box);
      var rows = (res.data || []).filter(function (s) { return s.status !== "cancelled"; });
      box.appendChild(el("b", "Members' in-stock buys"));
      if (!rows.length) { box.appendChild(el("p", "None yet.", "kit-help")); return; }
      var table = el("table", null, "kit-orders-table");
      var head = el("tr");
      ["Buy", "Member", "Phone", "Item", "Size", "Qty", "Total", "Status", ""].forEach(function (h) {
        head.appendChild(el("th", h));
      });
      table.appendChild(head);
      rows.forEach(function (s) {
        var tr = el("tr");
        [s.number, s.member_name || "", s.phone || "", s.item_name, variant(s.cut, s.size), String(s.quantity),
         money(s.total_sen), STATUS_WORDS[s.status]].forEach(function (c) { tr.appendChild(el("td", c)); });
        var td = el("td");
        var acts = s.status === "placed" ? [["paid", "Paid"]] : s.status === "paid" ? [["collected", "Collected"]] : [];
        acts.forEach(function (a) {
          td.appendChild(button(a[1], "kit-btn kit-btn--small", function () {
            client.rpc("stock_mark_sale", { p_sale: s.sale_id, p_action: a[0] }).then(function () { refresh(); });
          }));
        });
        if (s.status === "placed" || s.status === "paid") {
          td.appendChild(button("Cancel", "kit-btn kit-btn--small kit-btn--secondary", function () {
            if (s.status === "paid" && !window.confirm("Cancel " + s.number + "? The pieces go back into stock; refund by hand.")) return;
            client.rpc("stock_cancel_sale", { p_sale: s.sale_id }).then(function () { refresh(); });
          }));
        }
        tr.appendChild(td);
        table.appendChild(tr);
      });
      box.appendChild(table);
    });
  }

  function refresh() {
    showForSale();
    showManage();
  }

  var shownFor;
  function onSession(session) {
    var id = session && session.user ? session.user.id : null;
    if (id === shownFor) return;
    shownFor = id;
    user = session ? session.user : null;
    refresh();
  }
  client.auth.getSession().then(function (res) { onSession(res.data && res.data.session); });
  client.auth.onAuthStateChange(function (event, session) { onSession(session); });
})();
