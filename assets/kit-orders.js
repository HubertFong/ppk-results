// Kit pre-orders on the kit page (FEAT-040 S2, #292; several items per order, 0022).
// Members: build one order of several lines, place it, see My orders, cancel
// a line or the whole order until the lock, and read how to pay (with the
// DuitNow QR once they have an order). Kit organisers: load the round from
// the page, set how to pay and the QR, mark orders and lines, download the
// maker's list and lock the round. The database decides every rule; this
// script only asks and shows. It never writes HTML.
(function () {
  "use strict";

  var MAX_LINES = 10;
  var QR_SHAPE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/]+={0,2}$/;
  var QR_MAX_CHARS = 400000;

  function money(sen) {
    var whole = Math.floor(sen / 100), cents = sen % 100;
    return "RM" + whole + (cents ? "." + (cents < 10 ? "0" : "") + cents : "");
  }

  // The maker's list as CSV text: sizes and printed names only.
  function makerCsv(rows) {
    function cell(v) {
      var s = v == null ? "" : String(v);
      // A cell that starts like a formula is read as text by spreadsheets.
      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = ["item,cut,size,printed_name,quantity"];
    rows.forEach(function (r) {
      lines.push([r.item, r.cut, r.size, r.printed_name, r.quantity].map(cell).join(","));
    });
    return lines.join("\n") + "\n";
  }

  // A basket line's price, as the database will work it out.
  function lineTotal(line, round) {
    var item = round.items.filter(function (i) { return i.code === line.item; })[0];
    if (!item) return 0;
    var name = line.printed_name ? round.printed_name.price_sen : 0;
    return line.quantity * (item.price_sen + name);
  }

  function basketTotal(lines, round) {
    return lines.reduce(function (sum, l) { return sum + lineTotal(l, round); }, 0);
  }

  var STATUS_WORDS = { placed: "Not paid", paid: "Paid", collected: "Collected", cancelled: "Cancelled" };

  var api = { money: money, makerCsv: makerCsv, lineTotal: lineTotal, basketTotal: basketTotal,
              STATUS_WORDS: STATUS_WORDS, QR_SHAPE: QR_SHAPE, balanceText: balanceText };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  var root = document.getElementById("kit-orders");
  if (!root || !window.supabase) return;
  var roundSlug = root.getAttribute("data-round");
  var round;
  try {
    round = JSON.parse(root.getAttribute("data-round-json"));
  } catch (error) {
    return;
  }
  var client = supabase.createClient(root.getAttribute("data-supabase-url"),
                                     root.getAttribute("data-supabase-key"));
  var user = null;
  var memberRound = null;
  var basket = [];
  var names = {};
  round.items.forEach(function (i) { names[i.code] = i.name; });

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function say(node, text, isError) {
    node.textContent = text;
    node.className = isError ? "kit-error" : "kit-help";
    node.hidden = !text;
  }

  function button(text, className, onClick) {
    var b = el("button", text, className || "kit-btn");
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function label(text, control) {
    var wrap = el("label", null, "kit-field");
    wrap.appendChild(el("span", text));
    wrap.appendChild(control);
    return wrap;
  }

  // A refusal's own words, after "function_name: ".
  function words(error) {
    var m = (error && error.message) || "Something went wrong. Try again.";
    return m.replace(/^[a-z_]+: /, "");
  }

  function lineText(l) {
    return (names[l.item] || l.item) + (l.cut ? " · " + l.cut : "") + " · " + l.size + " · " + l.quantity +
      (l.printed_name ? " · name " + l.printed_name : "");
  }

  // ------------------------------------------------------------ how to pay

  function appendPayment(node, number) {
    var box = el("div", null, "kit-pay");
    box.appendChild(el("b", "How to pay"));
    var qr = memberRound && memberRound.payment_qr;
    if (qr && QR_SHAPE.test(qr)) {
      var img = document.createElement("img");
      img.className = "kit-qr";
      img.alt = "DuitNow QR to pay for your order";
      img.src = qr;
      box.appendChild(img);
    }
    box.appendChild(el("p", (memberRound && memberRound.payment_note) ||
                            "How to pay is sent to you soon."));
    box.appendChild(el("p", "Use your order number " + number + " as the reference.", "kit-help"));
    node.appendChild(box);
  }

  // ------------------------------------------------------------ the basket

  var basketBox = el("div", null, "kit-basket");
  basketBox.id = "kit-basket";
  basketBox.hidden = true;
  var mine = document.getElementById("kit-mine");
  if (mine) mine.parentNode.insertBefore(basketBox, mine);

  // Where the basket goes: a new order, or more lines on one of the
  // member's orders (until the cut-off).
  var basketTarget = null; // {id, number} or null

  function showBasket(placed) {
    clear(basketBox);
    if (!user || (!basket.length && !placed)) { basketBox.hidden = true; return; }
    basketBox.hidden = false;
    basketBox.appendChild(el("h2", basketTarget ? "Add to order " + basketTarget.number : "Your order",
                             "kit-section"));
    if (placed) {
      basketBox.appendChild(el("p", placed.number ? "Order " + placed.number + " placed: " + money(placed.total_sen) +
                                                    ". It counts once it is paid."
                                                  : "Added. The order's total is now " + money(placed.total_sen) + "."));
      if (placed.number) appendPayment(basketBox, placed.number);
      if (!basket.length) return;
    }
    var list = el("ul", null, "kit-mine-list");
    basket.forEach(function (line, i) {
      var li = el("li");
      li.appendChild(el("span", lineText(line) + " · " + money(lineTotal(line, round))));
      li.appendChild(button("Remove", "kit-btn kit-btn--small kit-btn--secondary", function () {
        basket.splice(i, 1);
        showBasket();
      }));
      list.appendChild(li);
    });
    basketBox.appendChild(list);
    basketBox.appendChild(el("p", "Total " + money(basketTotal(basket, round)) +
      ". You pay the full price now; the difference comes back after the lock. One order number, one payment."));
    var note = el("p");
    note.hidden = true;
    note.setAttribute("role", "status");
    var send = button(basketTarget ? "Add to order " + basketTarget.number : "Place order", "kit-btn", function () {
      send.disabled = true;
      var call = basketTarget
        ? client.rpc("kit_add_lines", { p_order: basketTarget.id, p_lines: basket })
        : client.rpc("place_kit_order", { p_round: roundSlug, p_lines: basket });
      call.then(function (res) {
        send.disabled = false;
        if (res.error) { say(note, words(res.error), true); return; }
        basket = [];
        basketTarget = null;
        refreshAll(res.data);
      }).catch(function () {
        send.disabled = false;
        say(note, "No connection. Try again.", true);
      });
    });
    basketBox.appendChild(send);
    if (basketTarget) {
      basketBox.appendChild(button("Make it a new order instead", "kit-btn kit-btn--small kit-btn--secondary", function () {
        basketTarget = null;
        showBasket();
      }));
    }
    basketBox.appendChild(note);
  }

  // A form to change one line: cut, size, quantity, printed name. After the
  // cut-off the quantity can only go down; after the lock (organiser only)
  // only the cut and size change.
  function changeForm(line, after, done) {
    var item = round.items.filter(function (i) { return i.code === line.item; })[0];
    var form = el("form", null, "kit-form");
    if (!item) return form;
    var cut = null;
    if (item.cuts.length) {
      cut = el("select");
      item.cuts.forEach(function (c) { cut.appendChild(new Option(c, c, false, c === line.cut)); });
      form.appendChild(label("Cut", cut));
    }
    var size = el("select");
    item.sizes.forEach(function (sz) { size.appendChild(new Option(sz, sz, false, sz === line.size)); });
    form.appendChild(label("Size", size));
    var qty = el("select");
    // A paid order can't grow, and after the cut-off no order can.
    var top = after === "open" && !line.paid ? 5 : line.quantity;
    for (var n = 1; n <= top; n++) qty.appendChild(new Option(String(n), String(n), false, n === line.quantity));
    qty.disabled = after === "locked";
    form.appendChild(label("Quantity", qty));
    var name = null;
    if (item.printed_name) {
      name = el("input");
      name.maxLength = round.printed_name.max_letters;
      name.value = line.printed_name || "";
      name.disabled = after === "locked";
      form.appendChild(label("Name to print (optional)", name));
    }
    var note = el("p"); note.hidden = true;
    var save = el("button", "Save the change", "kit-btn kit-btn--small");
    save.type = "submit";
    form.appendChild(save);
    form.appendChild(note);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      client.rpc("kit_change_line", { p_line: line.id || line.line_id, p_cut: cut ? cut.value : null,
                                      p_size: size.value, p_quantity: parseInt(qty.value, 10),
                                      p_printed_name: name && name.value.trim() ? name.value.trim() : null
      }).then(function (r) {
        if (r.error) say(note, words(r.error), true); else done();
      });
    });
    return form;
  }

  // An order's money, said once: what is still to pay, or to come back.
  function balanceText(status, total, paid, refunded) {
    if (status === "placed") return "";
    // A cancelled order owes back what was paid, whatever total it kept.
    var balance = status === "cancelled" ? refunded - paid : total - paid + refunded;
    if (balance > 0) return money(balance) + " to pay";
    if (balance < 0) return money(-balance) + " to refund";
    return "";
  }

  // The cut the member last picked on this page, for the next form.
  var lastCut = null;

  function addForm(item, slot) {
    clear(slot);
    var form = el("form", null, "kit-form");
    var cut = null;
    if (item.cuts.length) {
      cut = el("select");
      item.cuts.forEach(function (c) { cut.appendChild(new Option(c, c)); });
      form.appendChild(label("Cut", cut));
    }
    var size = el("select");
    item.sizes.forEach(function (s) { size.appendChild(new Option(s, s)); });
    form.appendChild(label("Size", size));
    // The size finder's suggestion (kit-size.js), if the member gave numbers.
    // It picks the size only while the member hasn't chosen one.
    var hint = el("p", null, "kit-suggest");
    hint.hidden = true;
    form.appendChild(hint);
    var chosen = false;
    size.addEventListener("change", function () { chosen = true; });
    function suggestSize() {
      if (!form.isConnected) {
        document.removeEventListener("ppk-size-finder", suggestSize);
        return;
      }
      var finder = window.PPKSizeFinder;
      var found = finder ? finder.suggestFor(item.code, cut ? cut.value : null) : [];
      hint.textContent = found.length ? "Suggested: " + found.join(" or ") : "";
      hint.hidden = !found.length;
      if (found.length === 1 && !chosen) size.value = found[0];
    }
    // Open on the cut chosen in the size finder; else the one cut it matched;
    // else the cut the member picked last. Never over the member's own choice.
    var cutChosen = false;
    function pickCut() {
      if (!cut || cutChosen || !form.isConnected) return;
      var finder = window.PPKSizeFinder;
      var mine = finder ? finder.cut() : null;
      if (mine && item.cuts.indexOf(mine) >= 0) { cut.value = mine; return; }
      var hits = finder ? item.cuts.filter(function (c) { return finder.suggestFor(item.code, c).length; }) : [];
      if (hits.length === 1) cut.value = hits[0];
      else if (lastCut && item.cuts.indexOf(lastCut) >= 0) cut.value = lastCut;
    }
    if (cut) {
      cut.addEventListener("change", function () {
        cutChosen = true;
        lastCut = cut.value;
        suggestSize();
      });
      document.addEventListener("ppk-size-finder", pickCut);
    }
    var qty = el("select");
    for (var n = 1; n <= 5; n++) qty.appendChild(new Option(String(n), String(n)));
    form.appendChild(label("Quantity", qty));
    var name = null;
    if (item.printed_name) {
      name = el("input");
      name.maxLength = round.printed_name.max_letters;
      name.autocomplete = "off";
      form.appendChild(label("Name to print (optional)", name));
    }
    var note = el("p");
    note.hidden = true;
    var add = el("button", "Add to order", "kit-btn");
    add.type = "submit";
    form.appendChild(add);
    form.appendChild(note);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (basket.length >= MAX_LINES) { say(note, "An order has up to " + MAX_LINES + " lines.", true); return; }
      var line = { item: item.code, cut: cut ? cut.value : null, size: size.value,
                   quantity: parseInt(qty.value, 10) };
      if (name && name.value.trim()) line.printed_name = name.value.trim();
      basket.push(line);
      showOrderButtons();
      showBasket();
    });
    slot.appendChild(form);
    document.addEventListener("ppk-size-finder", suggestSize);
    pickCut();
    suggestSize();
  }

  function showOrderButtons() {
    var open = memberRound && memberRound.open;
    round.items.forEach(function (item) {
      var card = document.querySelector('.kit-card[data-item="' + item.code + '"]');
      if (!card) return;
      var slot = card.querySelector(".kit-order");
      if (!slot) { slot = el("div", null, "kit-order"); card.appendChild(slot); }
      clear(slot);
      if (!user) {
        var a = el("a", "Sign in to order", "kit-btn kit-btn--secondary");
        a.href = "account.html";
        slot.appendChild(a);
      } else if (open) {
        slot.appendChild(button("Add to order", "kit-btn", function () { addForm(item, slot); }));
      }
    });
  }

  // ------------------------------------------------------------ my orders

  // "open" before the cut-off, "cut" from the cut-off to the lock, "locked" after.
  function stage() {
    if (!memberRound || memberRound.locked) return "locked";
    return memberRound.open ? "open" : "cut";
  }

  function loadMine() {
    if (!mine) return;
    clear(mine);
    if (!user) { mine.hidden = true; return; }
    mine.hidden = false;
    mine.appendChild(el("h2", "My orders", "kit-section"));
    var box = el("div");
    mine.appendChild(box);
    Promise.all([
      client.from("shop_orders").select("id,number,status,total_sen,paid_sen,refunded_sen,created_at")
        .order("created_at", { ascending: false }),
      client.from("shop_order_lines").select("id,order_id,position,item,cut,size,quantity,printed_name," +
        "total_sen,cancelled_at,not_made,refund_sen,refunded_at,give_back_sen,give_back_returned_at")
        .order("position", { ascending: true }),
      client.from("shop_order_changes").select("order_id,changed_at,by_organiser,what")
        .order("changed_at", { ascending: false })
    ]).then(function (res) {
      if (res[0].error || res[1].error) { box.appendChild(el("p", "Your orders could not be loaded.")); return; }
      if (!res[0].data.length) { box.appendChild(el("p", "No orders yet.")); return; }
      var now = stage();
      var changes = res[2].error ? [] : res[2].data;
      res[0].data.forEach(function (o) {
        var card = el("div", null, "kit-mine-order");
        var bal = balanceText(o.status, o.total_sen, o.paid_sen, o.refunded_sen);
        card.appendChild(el("b", o.number + " · " + (STATUS_WORDS[o.status] || o.status) + " · " +
                                 money(o.total_sen) + (bal ? " · " + bal : "")));
        var live = (o.status === "placed" || o.status === "paid") && now !== "locked";
        var list = el("ul", null, "kit-mine-list");
        res[1].data.filter(function (l) { return l.order_id === o.id; }).forEach(function (l) {
          var li = el("li");
          li.appendChild(el("span", lineText(l) + " · " + money(l.total_sen) +
                                    (l.cancelled_at ? " · removed" : "") + (l.not_made ? " · not made" : "")));
          if (l.refund_sen > 0) {
            li.appendChild(el("p", (l.refunded_at ? "Refunded " : "To refund: ") + money(l.refund_sen), "kit-help"));
          }
          if (l.give_back_sen > 0) {
            li.appendChild(el("p", (l.give_back_returned_at ? "Returned: " : "To give back: ") +
                                   money(l.give_back_sen), "kit-help"));
          }
          if (live && !l.cancelled_at) {
            var slot = el("div");
            var note = el("p"); note.hidden = true;
            slot.appendChild(button("Change", "kit-btn kit-btn--small kit-btn--secondary", function () {
              clear(slot);
              slot.appendChild(changeForm(Object.assign({ paid: o.status === "paid" }, l), now, refreshAll));
            }));
            slot.appendChild(button("Remove line", "kit-btn kit-btn--small kit-btn--secondary", function () {
              if (!window.confirm("Remove this line from the order?")) return;
              client.rpc("cancel_kit_order_line", { p_line: l.id }).then(function (r) {
                if (r.error) say(note, words(r.error), true); else refreshAll();
              });
            }));
            li.appendChild(slot);
            li.appendChild(note);
          }
          list.appendChild(li);
        });
        card.appendChild(list);
        if (o.status === "placed" || /to pay$/.test(bal)) appendPayment(card, o.number);
        if (/to refund$/.test(bal)) {
          card.appendChild(el("p", "We send " + bal.replace(" to refund", "") + " back to you by hand.", "kit-help"));
        }
        if (live && now === "open" && o.status === "placed") {
          card.appendChild(button("Add items to this order", "kit-btn kit-btn--secondary", function () {
            basketTarget = { id: o.id, number: o.number };
            basket = [];
            showBasket();
            basketBox.scrollIntoView();
          }));
        }
        if (live) {
          var note = el("p"); note.hidden = true;
          card.appendChild(button("Cancel the whole order", "kit-btn kit-btn--secondary", function () {
            if (!window.confirm("Cancel order " + o.number + "? Anything paid comes back to you.")) return;
            client.rpc("cancel_kit_order", { p_order: o.id }).then(function (r) {
              if (r.error) say(note, words(r.error), true); else refreshAll();
            });
          }));
          card.appendChild(note);
        }
        var mineChanges = changes.filter(function (c) { return c.order_id === o.id; }).slice(0, 5);
        if (mineChanges.length) {
          var log = el("ul", null, "kit-log");
          mineChanges.forEach(function (c) {
            log.appendChild(el("li", new Date(c.changed_at).toLocaleString() + " · " +
                                     (c.by_organiser ? "PPK: " : "You: ") + c.what));
          });
          card.appendChild(el("p", "What changed", "kit-label"));
          card.appendChild(log);
        }
        box.appendChild(card);
      });
    });
  }

  // ------------------------------------------------------------ organisers

  var org = document.getElementById("kit-organize");
  var pendingStatus = null; // [text, isError], shown after the next redraw

  // A phone photo of the QR, shrunk to at most 600 px, as a data URL.
  function qrDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        var img = new Image();
        img.onerror = reject;
        img.onload = function () {
          var scale = Math.min(1, 600 / Math.max(img.width, img.height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var url = canvas.toDataURL("image/png");
          if (url.length > QR_MAX_CHARS) url = canvas.toDataURL("image/jpeg", 0.85);
          resolve(url);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function loadOrganize() {
    if (!org) return;
    clear(org);
    org.hidden = true;
    if (!user) return;
    client.rpc("kit_round_orders", { p_round: roundSlug }).then(function (res) {
      if (res.error && res.error.code === "42501") return; // not a kit organiser
      org.hidden = false;
      org.appendChild(el("h2", "Kit organiser", "kit-section"));
      var status = el("p"); status.hidden = true; status.setAttribute("role", "status");
      org.appendChild(status);
      if (pendingStatus) { say(status, pendingStatus[0], pendingStatus[1]); pendingStatus = null; }

      org.appendChild(button("Load this round into the database", "kit-btn kit-btn--secondary", function () {
        client.rpc("kit_set_round", { p_round: round }).then(function (r) {
          if (r.error) say(status, words(r.error), true);
          else { pendingStatus = ["Round loaded."]; refreshAll(); }
        });
      }));

      var noteBox = el("textarea");
      noteBox.rows = 6;
      noteBox.maxLength = 1000;
      noteBox.value = (memberRound && memberRound.payment_note) || "";
      org.appendChild(label("How to pay, shown to members who order", noteBox));
      org.appendChild(button("Save how to pay", "kit-btn kit-btn--secondary", function () {
        client.rpc("kit_set_payment_note", { p_round: roundSlug, p_note: noteBox.value }).then(function (r) {
          if (r.error) say(status, words(r.error), true); else { pendingStatus = ["Saved."]; refreshAll(); }
        });
      }));

      var qrLine = el("p", null, "kit-help");
      org.appendChild(qrLine);
      client.rpc("kit_round_has_qr", { p_round: roundSlug }).then(function (r) {
        qrLine.textContent = r.error ? "" : (r.data ? "A payment QR is set; members with an order see it."
                                                    : "No payment QR yet.");
      });
      var file = el("input");
      file.type = "file";
      file.accept = "image/png,image/jpeg,image/webp";
      org.appendChild(label("Payment QR picture (DuitNow)", file));
      org.appendChild(button("Save the QR", "kit-btn kit-btn--secondary", function () {
        if (!file.files || !file.files[0]) { say(status, "Choose the QR picture first.", true); return; }
        qrDataUrl(file.files[0]).then(function (url) {
          if (!QR_SHAPE.test(url) || url.length > QR_MAX_CHARS) throw new Error("too big");
          return client.rpc("kit_set_payment_qr", { p_round: roundSlug, p_qr: url });
        }).then(function (r) {
          if (r.error) say(status, words(r.error), true); else { pendingStatus = ["QR saved."]; refreshAll(); }
        }).catch(function () { say(status, "That picture could not be used. Try a PNG or JPEG of the QR.", true); });
      }));
      org.appendChild(button("Remove the QR", "kit-btn kit-btn--small kit-btn--secondary", function () {
        if (!window.confirm("Remove the payment QR?")) return;
        client.rpc("kit_set_payment_qr", { p_round: roundSlug, p_qr: null }).then(function (r) {
          if (r.error) say(status, words(r.error), true); else { pendingStatus = ["QR removed."]; refreshAll(); }
        });
      }));

      if (res.error) { say(status, words(res.error), true); return; }

      var locked = memberRound && memberRound.locked;
      // Find and filter: by order number or member name, and by status.
      var find = el("input");
      find.placeholder = "Order number or name";
      var filter = el("select");
      [["all", "All orders"], ["placed", "Not paid"], ["paid", "Paid"], ["to_pay", "To pay more"],
       ["to_refund", "To refund"], ["collected", "Collected"], ["cancelled", "Cancelled"]].forEach(function (f) {
        filter.appendChild(new Option(f[1], f[0]));
      });
      org.appendChild(label("Find", find));
      org.appendChild(label("Show", filter));
      var table = el("table", null, "kit-orders-table");

      function matches(r) {
        var q = find.value.trim().toLowerCase();
        if (q && r.number.toLowerCase().indexOf(q) < 0 && (r.member_name || "").toLowerCase().indexOf(q) < 0) return false;
        var f = filter.value;
        if (f === "all") return true;
        if (f === "to_pay") return r.balance_sen > 0;
        if (f === "to_refund") return r.balance_sen < 0;
        return r.order_status === f;
      }

      function draw() {
        clear(table);
        var head = el("tr");
        ["Order", "Member", "Phone", "Item", "Size", "Qty", "Name", "Total", "Status", ""].forEach(function (h) {
          head.appendChild(el("th", h));
        });
        table.appendChild(head);
        var seen = {};
        res.data.filter(matches).forEach(function (r) {
          if (!seen[r.order_id]) {
            seen[r.order_id] = true;
            var tr = el("tr", null, "kit-order-head");
            var bal = balanceText(r.order_status, r.order_total_sen, r.paid_sen, r.refunded_sen);
            [r.number, r.member_name || "", r.phone || "", "", "", "", "", money(r.order_total_sen),
             (STATUS_WORDS[r.order_status] || r.order_status) + (bal ? " · " + bal : "")
            ].forEach(function (v) { tr.appendChild(el("td", v)); });
            var cell = el("td");
            var acts = [];
            if (!locked && (r.order_status === "placed" || (r.order_status === "paid" && r.balance_sen > 0))) {
              acts.push(["paid", r.order_status === "placed" ? "Paid" : "Paid the rest"]);
            }
            if (!locked && r.order_status === "paid" && r.balance_sen === 0 && !r.refunded_sen) {
              acts.push(["unpaid", "Not paid"]);
            }
            if (r.balance_sen < 0) acts.push(["refunded", "Refunded"]);
            if (locked && r.order_status === "paid" && r.balance_sen <= 0) acts.push(["collected", "Collected"]);
            acts.forEach(function (a) {
              cell.appendChild(button(a[1], "kit-btn kit-btn--small", function () {
                client.rpc("kit_mark_order", { p_order: r.order_id, p_action: a[0] }).then(function (x) {
                  if (x.error) say(status, words(x.error), true); else refreshAll();
                });
              }));
            });
            if (!locked && (r.order_status === "placed" || r.order_status === "paid")) {
              cell.appendChild(button("Cancel order", "kit-btn kit-btn--small kit-btn--secondary", function () {
                if (!window.confirm("Cancel order " + r.number + " for the member?")) return;
                client.rpc("cancel_kit_order", { p_order: r.order_id }).then(function (x) {
                  if (x.error) say(status, words(x.error), true); else refreshAll();
                });
              }));
            }
            tr.appendChild(cell);
            table.appendChild(tr);
          }
          var lr = el("tr");
          ["", "", "", (names[r.item] || r.item) + (r.cut ? " · " + r.cut : ""), r.size, String(r.quantity),
           r.printed_name || "", money(r.line_total_sen),
           (r.line_cancelled ? "removed" : "") + (r.not_made ? " not made" : "") +
             (r.refund_sen > 0 ? (r.refunded ? " · refunded" : " · refund " + money(r.refund_sen)) : "") +
             (r.give_back_sen > 0 ? (r.give_back_returned ? " · give-back returned"
                                                           : " · give back " + money(r.give_back_sen)) : "")
          ].forEach(function (v) { lr.appendChild(el("td", v)); });
          var lc = el("td");
          var lineActs = [];
          if (r.refund_sen > 0 && !r.refunded) lineActs.push(["refunded", "Refunded"]);
          if (r.give_back_sen > 0 && !r.give_back_returned) lineActs.push(["give_back_returned", "Give-back returned"]);
          lineActs.forEach(function (a) {
            lc.appendChild(button(a[1], "kit-btn kit-btn--small", function () {
              client.rpc("kit_mark_line", { p_line: r.line_id, p_action: a[0] }).then(function (x) {
                if (x.error) say(status, words(x.error), true); else refreshAll();
              });
            }));
          });
          if (!r.line_cancelled && (r.order_status === "placed" || r.order_status === "paid")) {
            lc.appendChild(button(locked ? "Swap size" : "Change", "kit-btn kit-btn--small kit-btn--secondary", function () {
              clear(lc);
              lc.appendChild(changeForm(Object.assign({ paid: r.order_status === "paid" }, r),
                                        locked ? "locked" : stage(), refreshAll));
            }));
            if (!locked) {
              lc.appendChild(button("Remove", "kit-btn kit-btn--small kit-btn--secondary", function () {
                if (!window.confirm("Remove this line for the member?")) return;
                client.rpc("cancel_kit_order_line", { p_line: r.line_id }).then(function (x) {
                  if (x.error) say(status, words(x.error), true); else refreshAll();
                });
              }));
            }
          }
          lr.appendChild(lc);
          table.appendChild(lr);
        });
      }
      find.addEventListener("input", draw);
      filter.addEventListener("change", draw);
      draw();
      org.appendChild(table);

      var logBox = el("div");
      org.appendChild(el("p", "Latest changes", "kit-label"));
      org.appendChild(logBox);
      client.rpc("kit_round_changes", { p_round: roundSlug }).then(function (x) {
        if (x.error || !x.data.length) { logBox.appendChild(el("p", "No changes yet.", "kit-help")); return; }
        var log = el("ul", null, "kit-log");
        x.data.slice(0, 30).forEach(function (c) {
          log.appendChild(el("li", new Date(c.changed_at).toLocaleString() + " · " + c.number + " · " +
                                   (c.by_organiser ? "organiser: " : "member: ") + c.what));
        });
        logBox.appendChild(log);
      });

      org.appendChild(button("Download the maker's list (CSV)", "kit-btn kit-btn--secondary", function () {
        client.rpc("kit_maker_list", { p_round: roundSlug }).then(function (r) {
          if (r.error) { say(status, words(r.error), true); return; }
          var blob = new Blob([makerCsv(r.data)], { type: "text/csv" });
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = roundSlug + "-maker.csv";
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        });
      }));

      org.appendChild(button("Lock the round", "kit-btn", function () {
        if (!window.confirm("Lock the round? Unpaid orders are cancelled, and each item's price is set. This happens once.")) return;
        client.rpc("kit_lock_round", { p_round: roundSlug }).then(function (r) {
          if (r.error) say(status, words(r.error), true);
          else { pendingStatus = [r.data && r.data.again ? "Already locked." : "Locked."]; refreshAll(); }
        });
      }));
    });
  }

  function refreshAll(placed) {
    var ask = user ? client.rpc("kit_round_for_member", { p_round: roundSlug })
                   : Promise.resolve({ data: null });
    ask.then(function (res) {
      memberRound = res && !res.error ? res.data : null;
      var signin = document.getElementById("kit-signin");
      if (signin) signin.hidden = !!user;
      showOrderButtons();
      showBasket(placed);
      loadMine();
      loadOrganize();
    });
  }

  var shownFor;
  function onSession(session) {
    var id = session && session.user ? session.user.id : null;
    if (id === shownFor) return;
    shownFor = id;
    user = session ? session.user : null;
    basket = [];
    refreshAll();
  }
  client.auth.getSession().then(function (res) { onSession(res.data && res.data.session); });
  client.auth.onAuthStateChange(function (event, session) { onSession(session); });
})();
