// Kit pre-orders on the kit page (FEAT-040 S2, #292).
// Members: order an item, see and cancel their own orders, and read how to
// pay. Kit organisers: load the round from the page, set the payment note,
// mark orders, download the maker's list and lock the round. The database
// decides every rule; this script only asks and shows. It never writes HTML.
(function () {
  "use strict";

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

  var STATUS_WORDS = { placed: "Not paid", paid: "Paid", collected: "Collected",
                       cancelled: "Cancelled", not_made: "Not made: full refund" };

  var api = { money: money, makerCsv: makerCsv, STATUS_WORDS: STATUS_WORDS };
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

  // A refusal's own words, after "function_name: ".
  function words(error) {
    var m = (error && error.message) || "Something went wrong. Try again.";
    return m.replace(/^[a-z_]+: /, "");
  }

  // ------------------------------------------------------------ members

  var mine = document.getElementById("kit-mine");
  var signin = document.getElementById("kit-signin");

  function orderForm(item, slot) {
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
    var qty = el("select");
    for (var n = 1; n <= 5; n++) qty.appendChild(new Option(String(n), String(n)));
    form.appendChild(label("Quantity", qty));
    var name = null;
    if (item.printed_name) {
      name = el("input");
      name.maxLength = round.printed_name.max_letters;
      name.autocomplete = "off";
      form.appendChild(label("Name to print (+" + money(round.printed_name.price_sen) +
                             ", optional, up to " + round.printed_name.max_letters + " letters)", name));
    }
    var total = el("p", null, "kit-help");
    function showTotal() {
      var each = item.price_sen + (name && name.value.trim() ? round.printed_name.price_sen : 0);
      total.textContent = "Total " + money(each * parseInt(qty.value, 10)) +
        ". You pay the full price now; the difference comes back after the cut-off.";
    }
    qty.addEventListener("change", showTotal);
    if (name) name.addEventListener("input", showTotal);
    showTotal();
    form.appendChild(total);
    var send = el("button", "Place order", "kit-btn");
    send.type = "submit";
    form.appendChild(send);
    var note = el("p");
    note.hidden = true;
    note.setAttribute("role", "status");
    form.appendChild(note);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      send.disabled = true;
      client.rpc("place_kit_order", {
        p_round: roundSlug, p_item: item.code, p_cut: cut ? cut.value : null, p_size: size.value,
        p_quantity: parseInt(qty.value, 10), p_printed_name: name && name.value.trim() ? name.value.trim() : null
      }).then(function (res) {
        send.disabled = false;
        if (res.error) { say(note, words(res.error), true); return; }
        clear(slot);
        var done = el("div", null, "kit-placed");
        done.appendChild(el("p", "Order " + res.data.number + " placed: " + money(res.data.total_sen) + ". It counts once it is paid."));
        appendPayment(done, res.data.number);
        slot.appendChild(done);
        refreshAll(slot);
      }).catch(function () {
        send.disabled = false;
        say(note, "No connection. Try again.", true);
      });
    });
    slot.appendChild(form);
  }

  function label(text, control) {
    var wrap = el("label", null, "kit-field");
    wrap.appendChild(el("span", text));
    wrap.appendChild(control);
    return wrap;
  }

  function appendPayment(node, number) {
    if (memberRound && memberRound.payment_note) {
      node.appendChild(el("p", "How to pay (write your order number " + number + " with the payment):"));
      node.appendChild(el("p", memberRound.payment_note, "kit-pay"));
    } else {
      node.appendChild(el("p", "How to pay is sent to you soon. Keep your order number: " + number + "."));
    }
  }

  function showOrderButtons(keepSlot) {
    var open = memberRound && memberRound.open;
    round.items.forEach(function (item) {
      var card = document.querySelector('.kit-card[data-item="' + item.code + '"]');
      if (!card) return;
      var slot = card.querySelector(".kit-order");
      if (!slot) { slot = el("div", null, "kit-order"); card.appendChild(slot); }
      if (slot === keepSlot) return;
      clear(slot);
      if (!user) {
        var a = el("a", "Sign in to order", "kit-btn kit-btn--secondary");
        a.href = "account.html";
        slot.appendChild(a);
      } else if (open) {
        var b = el("button", "Order", "kit-btn");
        b.type = "button";
        b.addEventListener("click", function () { orderForm(item, slot); });
        slot.appendChild(b);
      }
    });
  }

  function loadMine() {
    clear(mine);
    if (!user) { mine.hidden = true; return; }
    mine.hidden = false;
    mine.appendChild(el("h2", "My orders", "kit-section"));
    var list = el("ul", null, "kit-mine-list");
    mine.appendChild(list);
    var names = {};
    round.items.forEach(function (i) { names[i.code] = i.name; });
    client.from("shop_orders")
      .select("id,number,item,cut,size,quantity,printed_name,total_sen,status,refund_sen,refunded_at,give_back_sen,give_back_returned_at")
      .order("created_at", { ascending: false })
      .then(function (res) {
        if (res.error) { list.appendChild(el("li", "Your orders could not be loaded.")); return; }
        if (!res.data.length) { list.appendChild(el("li", "No orders yet.")); return; }
        res.data.forEach(function (o) {
          var li = el("li");
          li.appendChild(el("b", o.number + " · " + (STATUS_WORDS[o.status] || o.status)));
          li.appendChild(el("span", " " + (names[o.item] || o.item) + (o.cut ? " · " + o.cut : "") + " · " +
                            o.size + " · " + o.quantity + (o.printed_name ? " · " + o.printed_name : "") +
                            " · " + money(o.total_sen)));
          if (o.refund_sen > 0) {
            li.appendChild(el("p", (o.refunded_at ? "Refunded " : "To refund: ") + money(o.refund_sen), "kit-help"));
          }
          if (o.give_back_sen > 0) {
            li.appendChild(el("p", (o.give_back_returned_at ? "Returned: " : "To give back: ") + money(o.give_back_sen), "kit-help"));
          }
          if (o.status === "placed") appendPayment(li, o.number);
          if ((o.status === "placed" || o.status === "paid") && memberRound && !memberRound.locked) {
            var cancel = el("button", "Cancel order", "kit-btn kit-btn--secondary");
            cancel.type = "button";
            var note = el("p"); note.hidden = true;
            cancel.addEventListener("click", function () {
              if (!window.confirm("Cancel order " + o.number + "? A paid order is refunded in full.")) return;
              client.rpc("cancel_kit_order", { p_order: o.id }).then(function (r) {
                if (r.error) say(note, words(r.error), true); else loadMine();
              });
            });
            li.appendChild(cancel);
            li.appendChild(note);
          }
          list.appendChild(li);
        });
      });
  }

  // ------------------------------------------------------------ organisers

  var org = document.getElementById("kit-organize");
  var pendingStatus = null; // [text, isError], shown after the next redraw

  function loadOrganize() {
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

      var load = el("button", "Load this round into the database", "kit-btn kit-btn--secondary");
      load.type = "button";
      load.addEventListener("click", function () {
        client.rpc("kit_set_round", { p_round: round }).then(function (r) {
          if (r.error) say(status, words(r.error), true);
          else { pendingStatus = ["Round loaded."]; refreshAll(); }
        });
      });
      org.appendChild(load);

      var noteBox = el("textarea");
      noteBox.rows = 4;
      noteBox.maxLength = 1000;
      noteBox.value = (memberRound && memberRound.payment_note) || "";
      org.appendChild(label("How to pay, shown to members who order (bank, DuitNow or the CHIP link)", noteBox));
      var saveNote = el("button", "Save how to pay", "kit-btn kit-btn--secondary");
      saveNote.type = "button";
      saveNote.addEventListener("click", function () {
        client.rpc("kit_set_payment_note", { p_round: roundSlug, p_note: noteBox.value }).then(function (r) {
          if (r.error) say(status, words(r.error), true); else { pendingStatus = ["Saved."]; refreshAll(); }
        });
      });
      org.appendChild(saveNote);

      if (res.error) { say(status, words(res.error), true); return; }

      var table = el("table", null, "kit-orders-table");
      var head = el("tr");
      ["Order", "Member", "Phone", "Item", "Size", "Qty", "Name", "Total", "Status", ""].forEach(function (h) {
        head.appendChild(el("th", h));
      });
      table.appendChild(head);
      var locked = memberRound && memberRound.locked;
      var actions = locked ? { paid: [["collected", "Collected"]] }
                           : { placed: [["paid", "Paid"]], paid: [["unpaid", "Not paid"]] };
      res.data.forEach(function (o) {
        var tr = el("tr");
        [o.number, o.member_name || "", o.phone || "", o.item + (o.cut ? " · " + o.cut : ""), o.size,
         String(o.quantity), o.printed_name || "", money(o.total_sen),
         (STATUS_WORDS[o.status] || o.status) +
           (o.refund_sen > 0 ? (o.refunded ? " · refunded" : " · refund " + money(o.refund_sen)) : "") +
           (o.give_back_sen > 0 ? (o.give_back_returned ? " · give-back returned" : " · give back " + money(o.give_back_sen)) : "")
        ].forEach(function (v) { tr.appendChild(el("td", v)); });
        var cell = el("td");
        var list = (actions[o.status] || []).slice();
        if (o.refund_sen > 0 && !o.refunded) list.push(["refunded", "Refunded"]);
        if (o.give_back_sen > 0 && !o.give_back_returned) list.push(["give_back_returned", "Give-back returned"]);
        list.forEach(function (a) {
          var b = el("button", a[1], "kit-btn kit-btn--small");
          b.type = "button";
          b.addEventListener("click", function () {
            client.rpc("kit_mark_order", { p_order: o.id, p_action: a[0] }).then(function (r) {
              if (r.error) say(status, words(r.error), true); else refreshAll();
            });
          });
          cell.appendChild(b);
        });
        tr.appendChild(cell);
        table.appendChild(tr);
      });
      org.appendChild(table);

      var csv = el("button", "Download the maker's list (CSV)", "kit-btn kit-btn--secondary");
      csv.type = "button";
      csv.addEventListener("click", function () {
        client.rpc("kit_maker_list", { p_round: roundSlug }).then(function (r) {
          if (r.error) { say(status, words(r.error), true); return; }
          var blob = new Blob([makerCsv(r.data)], { type: "text/csv" });
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = roundSlug + "-maker.csv";
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        });
      });
      org.appendChild(csv);

      var lock = el("button", "Lock the round", "kit-btn");
      lock.type = "button";
      lock.addEventListener("click", function () {
        if (!window.confirm("Lock the round? Unpaid orders are cancelled, and each item's price is set. This happens once.")) return;
        client.rpc("kit_lock_round", { p_round: roundSlug }).then(function (r) {
          if (r.error) say(status, words(r.error), true);
          else { pendingStatus = [r.data && r.data.again ? "Already locked." : "Locked."]; refreshAll(); }
        });
      });
      org.appendChild(lock);
    });
  }

  function refreshAll(keepSlot) {
    var ask = user ? client.rpc("kit_round_for_member", { p_round: roundSlug })
                   : Promise.resolve({ data: null });
    ask.then(function (res) {
      memberRound = res && !res.error ? res.data : null;
      signin.hidden = !!user;
      showOrderButtons(keepSlot);
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
    refreshAll();
  }
  client.auth.getSession().then(function (res) { onSession(res.data && res.data.session); });
  client.auth.onAuthStateChange(function (event, session) { onSession(session); });
})();
