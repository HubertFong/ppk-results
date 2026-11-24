/* An away trip page whose facts an organiser keeps in the events table
 * (FEAT-064 S6 and S7, #275, #276).
 *
 * The page is built with the facts as they were at the last publish. This
 * script reads the table with the publishable key and adds what changed
 * since: a "Latest updates" box at the top, a line in each section that
 * shows an older value, and PPK's suggestions as they are now. The rest of
 * the page follows at the next publish, because the build works the
 * timeline and the drawings out of the facts.
 *
 * A failed read changes nothing: the page stays as it was built.
 *
 * A classic script with no dependency. site_trips.py writes #trip-live just
 * before it: where to read, and what the build showed (data-built). Every
 * value reaches the page as text, and a link only when it starts https://.
 */
(function () {
  "use strict";

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var TBC = "to be confirmed";

  // The same text for the same data, whatever order its keys came in.
  function canonical(value) {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ":" + canonical(value[key]);
      }).join(",") + "}";
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  // The table's facts that differ from what the build showed. A fact the
  // build doesn't know is left out: this page has no place for it.
  function changedFacts(built, rows) {
    var changed = [];
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || (row.grp !== "facts" && row.grp !== "plan")) return;
      var group = built[row.grp] || {};
      if (!Object.prototype.hasOwnProperty.call(group, row.name)) return;
      if (!row.fact || typeof row.fact !== "object") return;
      if (canonical(row.fact) === canonical(group[row.name])) return;
      changed.push({ group: row.grp, name: row.name, fact: row.fact });
    });
    return changed;
  }

  // The parts of a list item a reader is shown: a distance, a schedule
  // step or a road closure. A route file's name is not one of them.
  var ITEM_KEYS = ["km", "kind", "start", "cut_off", "time", "what", "road", "when"];

  function itemText(item) {
    if (item && typeof item === "object") {
      return ITEM_KEYS.filter(function (key) {
        return typeof item[key] === "string" || typeof item[key] === "number";
      }).map(function (key) {
        return key === "km" ? item[key] + " km" : String(item[key]);
      }).join(" · ");
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(String(item)) ? dateText(item) : String(item);
  }

  function valueText(value) {
    if (value === null || value === undefined) return TBC;
    if (Array.isArray(value)) return value.map(itemText).join("; ");
    return itemText(value);
  }

  // "2027-03-12" as "12 Mar 2027"; anything else as it is.
  function dateText(iso) {
    var found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!found || !MONTHS[Number(found[2]) - 1]) return String(iso || "");
    return Number(found[3]) + " " + MONTHS[Number(found[2]) - 1] + " " + found[1];
  }

  function safeLink(url) {
    return typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : "";
  }

  // A fact's sources: a link's site name with its address, or plain text
  // for PPK's own plan ("PPK trip plan, 2 Mar 2027").
  function sourceParts(fact) {
    return (Array.isArray(fact.sources) ? fact.sources : []).map(function (source) {
      var href = safeLink(source);
      if (!href) return { text: String(source), href: "" };
      return { text: href.split("/")[2].replace(/^www\./, ""), href: href };
    });
  }

  // Section id -> the labels of its facts that changed.
  function changedSections(sections, labels, changed) {
    var result = {};
    Object.keys(sections || {}).forEach(function (id) {
      var names = changed.filter(function (item) {
        return sections[id].indexOf(item.name) !== -1;
      }).map(function (item) { return labels[item.name] || item.name; });
      if (names.length) result[id] = names;
    });
    return result;
  }

  function pickRows(rows) {
    return (Array.isArray(rows) ? rows : []).filter(function (row) {
      return row && typeof row === "object";
    }).slice().sort(function (a, b) {
      return (a.position || 0) - (b.position || 0);
    }).map(function (row) {
      var pick = {};
      ["kind", "place", "map_link", "note", "meetup_time"].forEach(function (key) {
        if (row[key] !== null && row[key] !== undefined) pick[key] = row[key];
      });
      return pick;
    });
  }

  var api = {
    canonical: canonical, changedFacts: changedFacts, valueText: valueText, dateText: dateText,
    safeLink: safeLink, sourceParts: sourceParts, changedSections: changedSections,
    pickRows: pickRows
  };
  // Under Node, for the tests: the functions above and nothing else.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  var liveEl = document.getElementById("trip-live");
  var tripEl = document.querySelector(".trip");
  if (!liveEl || !tripEl || !window.fetch) return;
  var built;
  try {
    built = JSON.parse(liveEl.getAttribute("data-built"));
  } catch (error) {
    return;
  }

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function sourceLine(fact) {
    var line = el("small");
    if (fact.value === null || fact.value === undefined) {
      line.textContent = "No longer confirmed.";
      return line;
    }
    line.appendChild(document.createTextNode("Checked " + dateText(fact.checked) + " against "));
    sourceParts(fact).forEach(function (part, index) {
      if (index) line.appendChild(document.createTextNode(", "));
      if (part.href) {
        var link = el("a", part.text);
        link.href = part.href;
        line.appendChild(link);
      } else {
        line.appendChild(document.createTextNode(part.text));
      }
    });
    return line;
  }

  function showUpdates(changed) {
    var box = el("section", "", "trip-card trip-updates");
    box.id = "latest";
    box.appendChild(el("h2", "Latest updates"));
    box.appendChild(el("p", "Changed since this page was last built. The rest of the page " +
                            "follows at the next publish.", "trip-muted"));
    var list = el("ul");
    changed.forEach(function (item) {
      var row = el("li");
      row.appendChild(el("b", (built.labels[item.name] || item.name) + ": " + valueText(item.fact.value)));
      row.appendChild(sourceLine(item.fact));
      list.appendChild(row);
    });
    box.appendChild(list);
    var first = tripEl.querySelector(".trip-card");
    tripEl.insertBefore(box, first && first.parentNode === tripEl ? first : null);

    var sections = changedSections(built.sections, built.labels, changed);
    Object.keys(sections).forEach(function (id) {
      var section = document.getElementById(id);
      if (!section) return;
      var note = el("p", "", "trip-warn trip-changed");
      note.setAttribute("role", "note");
      note.appendChild(el("b", sections[id].join(", ") +
                               (sections[id].length === 1 ? " has changed." : " have changed.")));
      var link = el("a", "See Latest updates");
      link.href = "#latest";
      note.appendChild(document.createTextNode(" "));
      note.appendChild(link);
      // After the heading, or after the row that holds it; at the top otherwise.
      var after = section.querySelector("h2");
      while (after && after.parentNode !== section) after = after.parentNode;
      section.insertBefore(note, after ? after.nextSibling : section.firstChild);
    });
  }

  // PPK's suggestions as they are now, in the markup site_trips.py builds.
  function showPicks(picks) {
    var section = document.getElementById("food");
    if (!picks.length) {
      if (section) section.hidden = true;
      return;
    }
    if (!section) {
      section = el("section", "", "trip-card");
      section.id = "food";
      var before = document.getElementById("emergency");
      tripEl.insertBefore(section, before && before.parentNode === tripEl ? before : null);
    }
    section.hidden = false;
    while (section.firstChild) section.removeChild(section.firstChild);
    section.appendChild(el("h2", "Food and sightseeing"));
    var line = el("p", built.picksLine, "trip-muted");
    line.style.marginTop = "0";
    section.appendChild(line);
    (built.kinds || []).forEach(function (kind) {
      var rows = picks.filter(function (pick) { return pick.kind === kind[0]; });
      if (!rows.length) return;
      section.appendChild(el("p", kind[1], "trip-sub"));
      var list = el("ul", "", "trip-rows");
      rows.forEach(function (pick) {
        var row = el("li");
        var text = el("div");
        text.appendChild(el("b", String(pick.place || "")));
        text.appendChild(el("small", (pick.meetup_time ? "Meet " + pick.meetup_time + " · " : "") +
                                     String(pick.note || "")));
        row.appendChild(text);
        var href = safeLink(pick.map_link);
        if (href) {
          var map = el("a", "Map", "btn btn-line btn-small");
          map.href = href;
          map.setAttribute("aria-label", "Map: " + String(pick.place || ""));
          row.appendChild(map);
        }
        list.appendChild(row);
      });
      section.appendChild(list);
    });
  }

  var url = liveEl.getAttribute("data-supabase-url").replace(/\/+$/, "") +
    "/rest/v1/events?select=id,event_facts(grp,name,fact)," +
    "event_recommendations(position,kind,place,map_link,note,meetup_time)" +
    "&status=eq.published&slug=eq." + encodeURIComponent(liveEl.getAttribute("data-event"));
  fetch(url, { headers: { apikey: liveEl.getAttribute("data-supabase-key"),
                          Accept: "application/json" } })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (rows) {
      // No row: the event is off the site for now. Keep the built page.
      if (!Array.isArray(rows) || rows.length !== 1) return;
      var changed = changedFacts(built, rows[0].event_facts);
      var picks = pickRows(rows[0].event_recommendations);
      // Each on its own: a page that has no place for one still gets the other.
      try {
        if (changed.length) showUpdates(changed);
      } catch (error) { /* the built page stays */ }
      try {
        if (canonical(picks) !== canonical(built.picks || [])) showPicks(picks);
      } catch (error) { /* the built page stays */ }
    })
    .catch(function () {
      // A failed read shows the build's values: nothing to do.
    });
})();
