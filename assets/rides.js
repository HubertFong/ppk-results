/* The PPK member rides page: the upcoming group rides and their meet-up
 * points, with sign-up, cancel and the join point for signed-in members.
 *
 * A classic script, loaded at the end of the body by site_rides.py, so every
 * element below already exists when it runs. Its only dependency is the
 * global `supabase` from the pinned supabase-js tag on the same page.
 * Config comes from #rides-root's data attributes, never from inline text.
 */
(function () {
  "use strict";

  // Exactly the columns 0006_rides.sql grants. select("*") is refused,
  // because created_by is not readable.
  var RIDE_SELECT =
    "id, title, meeting_point, meeting_map_link, meet_at, depart_at, " +
    "route_link, distance_m, climbing_m, regroup_policy, pace_note, " +
    "capacity, signup_deadline, status";

  // An organizer's own session can read drafts as well, so the list names the
  // three statuses a rider may see: a draft must never show here.
  var VISIBLE_STATUSES = ["published", "postponed", "cancelled"];

  var rootEl = document.getElementById("rides-root");
  var sessionEl = document.getElementById("rides-session");
  var organizeEl = document.getElementById("rides-organize");
  var loadingEl = document.getElementById("rides-loading");
  var listEl = document.getElementById("rides-list");
  var emptyEl = document.getElementById("rides-empty");
  var statusEl = document.getElementById("rides-status");
  var errorEl = document.getElementById("rides-error");

  var client = supabase.createClient(rootEl.dataset.supabaseUrl, rootEl.dataset.supabaseKey);

  var currentUser = null; // the signed-in member, or null
  var loadedUserId;       // whose session the list holds; undefined until the first report
  var listVersion = 0;    // bumped on every rides reload, drops stale replies
  var sharedRideShown = false; // the ?ride= card is found on the first list build only
  var sharedRideItem = null;    // that card, until the list around it stops growing
  var placesPending = 0;        // places reads still out for the current list

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // Nodes are built from data with textContent and properties, never markup.
  function textBlock(tag, text, className) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function actionButton(label, onClick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }

  // One paragraph for whatever went wrong. A refusal from join_ride() or
  // cancel_ride_signup() is shown as the server's own message: it names the
  // rule that was hit, which this page cannot word better.
  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  // join_ride() refuses an incomplete safety set with this hint (#97).
  function showSafetyNeeded() {
    clearChildren(errorEl);
    errorEl.appendChild(document.createTextNode("Complete your safety details first: "));
    var link = document.createElement("a");
    link.href = returnToHref();
    link.textContent = "go to your account page";
    errorEl.appendChild(link);
    errorEl.appendChild(document.createTextNode("."));
    errorEl.hidden = false;
  }

  // The server words a refusal as "join_ride: this ride is full"; the member
  // needs the reason, not the function's name.
  function refusalText(message) {
    var reason = String(message || "something went wrong").replace(/^[a-z_]+: /, "");
    reason = reason.charAt(0).toUpperCase() + reason.slice(1);
    return /[.!?]$/.test(reason) ? reason : reason + ".";
  }

  // --------------------------------------------------------------- session

  // Where to come back to after signing in: this page, query string and all.
  function returnToHref() {
    return "account.html?returnTo=" + encodeURIComponent(location.pathname + location.search);
  }

  function showSessionLine(user) {
    clearChildren(sessionEl);
    if (user) {
      sessionEl.textContent = "You're signed in as " + (user.email || "");
      return;
    }
    sessionEl.appendChild(document.createTextNode("Sign in on your account page to sign up: "));
    var link = document.createElement("a");
    link.id = "rides-signin-link";
    link.href = returnToHref();
    link.textContent = "sign in";
    sessionEl.appendChild(link);
  }

  // The link is a convenience for the ride organizer: organize.html and the
  // organizer functions check the grant again on the server (#75).
  function showOrganizeLink(user) {
    organizeEl.hidden = true;
    if (!user) return;
    client.rpc("has_club_role", { required_role: "event_organizer" }).then(function (res) {
      // A reply for a member who has since signed out is dropped.
      if (!currentUser || currentUser.id !== user.id) return;
      organizeEl.hidden = res.data !== true;
    });
  }

  // A signed-in member must complete their safety details before joining a
  // ride (#97), so they go to the account page first and come back here.
  // Only a clear "false" sends them: an error leaves the page as it is, and
  // join_ride() still refuses on the server.
  function checkSafetySet(user) {
    if (!user) return;
    client.rpc("safety_set_complete").then(function (res) {
      if (!currentUser || currentUser.id !== user.id) return;
      if (!res.error && res.data === false) window.location.assign(returnToHref());
    });
  }

  function applySession(session) {
    var user = session ? session.user : null;
    currentUser = user;
    showSessionLine(user);
    showOrganizeLink(user);
    checkSafetySet(user);
    // getSession() and INITIAL_SESSION report the same session, so only a
    // change of member re-reads the rides.
    var userId = user ? user.id : null;
    if (userId === loadedUserId) return;
    loadedUserId = userId;
    // A result line for the member who just left is not this visitor's.
    statusEl.textContent = "";
    loadRides();
  }

  // ---------------------------------------------------------- ride details

  function formatTime(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      // An unreadable timestamp still says something rather than nothing.
      return value === null || value === undefined ? "" : String(value);
    }
    return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  }

  function isBefore(value) {
    var date = new Date(value);
    return !Number.isNaN(date.getTime()) && Date.now() < date.getTime();
  }

  function distanceLine(ride) {
    if (ride.distance_m === null || ride.distance_m === undefined) return null;
    return textBlock("div", "Distance: " + (ride.distance_m / 1000).toFixed(1) + " km");
  }

  function climbingLine(ride) {
    if (ride.climbing_m === null || ride.climbing_m === undefined) return null;
    return textBlock("div", "Climbing: " + ride.climbing_m + " m");
  }

  // A "Label: value" line, or null when the ride has nothing to say there.
  function textLine(label, value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    return textBlock("div", label + ": " + value);
  }

  // A link only for a URL the browser reads as http(s): a stored javascript:
  // or data: URL would otherwise become a live link.
  function externalLink(url, label) {
    if (typeof url !== "string" || url === "") return null;
    var protocol;
    try {
      protocol = new URL(url).protocol;
    } catch (error) {
      return null;
    }
    if (protocol !== "http:" && protocol !== "https:") return null;
    var link = document.createElement("a");
    link.href = url;
    link.textContent = label;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    return link;
  }

  // One line per start point: the ride's own point (1) first, then each
  // extra point in position order, with its own Map link. The lines are
  // siblings, so they come back as an array for the caller to append.
  function meetLine(ride, points) {
    var lines = [];
    var line = textBlock("div",
      "Meet: " + formatTime(ride.meet_at) + " at " + (ride.meeting_point || ""));
    var mapLink = externalLink(ride.meeting_map_link, "Map");
    if (mapLink) {
      line.appendChild(document.createTextNode(" "));
      line.appendChild(mapLink);
    }
    lines.push(line);
    (points || []).forEach(function (point) {
      var also = textBlock("div",
        "Or start: " + formatTime(point.start_at) + " at " + point.place);
      var pointMap = externalLink(point.map_link, "Map");
      if (pointMap) {
        also.appendChild(document.createTextNode(" "));
        also.appendChild(pointMap);
      }
      lines.push(also);
    });
    return lines;
  }

  // The departure is worth its own line only when it differs from the
  // meet-up time; the same time twice tells the rider nothing.
  function departsLine(ride) {
    if (new Date(ride.depart_at).getTime() === new Date(ride.meet_at).getTime()) {
      return null;
    }
    return textBlock("div", "Departs: " + formatTime(ride.depart_at));
  }

  function routeLine(ride) {
    var routeLink = externalLink(ride.route_link, "Route");
    if (!routeLink) return null;
    var line = document.createElement("div");
    line.appendChild(routeLink);
    return line;
  }

  // A ride with no limit (#96) shows how many riders are joining instead of
  // places left.
  function placesLine(ride, taken) {
    if (ride.capacity === null) return textBlock("div", "Riders joining: " + taken);
    // An organizer can lower the capacity below the places already taken, so
    // the difference is never shown as a negative number.
    var left = Math.max(0, ride.capacity - taken);
    return textBlock("div", "Places left: " + left + " of " + ride.capacity);
  }

  // Hubert, 2026-09-30 (#93): most rides have no limit, and riders who
  // haven't signed up are still welcome at the start.
  function optionalLine(ride) {
    if (ride.capacity !== null) return null;
    return textBlock("div", "Sign-up is optional. You can still join us at the meeting point.", "note");
  }

  // -------------------------------------------------------------- sharing

  // What the WhatsApp message carries: the ride's own words, and a link the
  // receiver can open.
  function shareText(ride, url) {
    return ride.title + "\n" + formatTime(ride.meet_at) + " at " +
      (ride.meeting_point || "") + "\nSign up: " + url;
  }

  // Only a published or postponed ride is worth sharing: a cancelled ride is
  // a message nobody should send. The ride's card on this page is the link at
  // first; the per-ride share page (r/<ride id>.html) is written only when
  // the site is published, so a HEAD asks whether it exists and, if so, it
  // becomes the link. A failed HEAD leaves the fallback in place.
  function shareLink(ride) {
    var link = document.createElement("a");
    link.className = "btn share-btn";
    link.textContent = "Share on WhatsApp";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    var url = new URL("rides.html?ride=" + encodeURIComponent(ride.id),
      window.location.href).href;
    link.href = "https://wa.me/?text=" + encodeURIComponent(shareText(ride, url));
    var sharePage = new URL("r/" + ride.id.toLowerCase() + ".html",
      window.location.href).href;
    fetch(sharePage, { method: "HEAD", cache: "no-store" }).then(function (res) {
      if (!res.ok) return;
      link.href = "https://wa.me/?text=" + encodeURIComponent(shareText(ride, sharePage));
    }).catch(function () {
      // Offline, or the page was never written: keep the card link.
    });
    return link;
  }

  // The share link's own line, or null for a ride that cannot be shared.
  function shareLine(ride) {
    if (ride.status !== "published" && ride.status !== "postponed") return null;
    var line = document.createElement("div");
    line.className = "ride-share";
    line.appendChild(shareLink(ride));
    return line;
  }

  // -------------------------------------------------------------- actions

  // A member whose earlier sign-up was cancelled is signing up again: the row
  // is still there, and join_ride() sends a rejoin to the back of the queue.
  function joinButton(ride, signupStatus) {
    var label = signupStatus === "cancelled" ? "Sign up again" : "Sign up";
    var button = actionButton(label, function () { joinRide(ride, button); });
    return button;
  }

  function joinRide(ride, button) {
    clearError();
    button.disabled = true;
    client.rpc("join_ride", { ride_id: ride.id }).then(function (res) {
      button.disabled = false;
      if (res.error) {
        if (res.error.hint === "safety_set_incomplete") {
          showSafetyNeeded();
          return;
        }
        showError(refusalText(res.error.message));
        return;
      }
      // 'confirmed', or 'already_confirmed' for a member who was in already.
      statusEl.textContent = res.data === "already_confirmed"
        ? "You were already signed up."
        : "You're signed up.";
      loadRides();
    });
  }

  function cancelButton(ride) {
    var button = actionButton("Cancel my place", function () { cancelSignup(ride, button); });
    return button;
  }

  function cancelSignup(ride, button) {
    if (!window.confirm("Cancel your place on this ride?")) return;
    clearError();
    button.disabled = true;
    client.rpc("cancel_ride_signup", { ride_id: ride.id }).then(function (res) {
      button.disabled = false;
      if (res.error) {
        showError(refusalText(res.error.message));
        return;
      }
      // 'cancelled', or 'not_signed_up' when there was no confirmed place.
      statusEl.textContent = res.data === "not_signed_up"
        ? "You weren't signed up."
        : "Your place is cancelled.";
      loadRides();
    });
  }

  // A confirmed rider on a ride that has extra start points picks where
  // they start. choose_start() checks the ride, the sign-up and the point
  // again, so a refusal from the server is shown as it comes.
  function startChoice(ride, points, chosen) {
    var label = document.createElement("label");
    label.appendChild(document.createTextNode("Starting at: "));
    var select = document.createElement("select");
    var mainOption = document.createElement("option");
    mainOption.value = "1";
    mainOption.textContent = formatTime(ride.meet_at) + " at " +
      (ride.meeting_point || "");
    select.appendChild(mainOption);
    points.forEach(function (point) {
      var option = document.createElement("option");
      option.value = String(point.position);
      option.textContent = formatTime(point.start_at) + " at " + point.place;
      select.appendChild(option);
    });
    // A null choice is the ride's own point; so is a chosen point that has
    // since been removed from the ride.
    select.value = String(chosen || 1);
    if (select.selectedIndex < 0) select.value = "1";
    var previous = select.value;
    select.addEventListener("change", function () {
      clearError();
      select.disabled = true;
      var wanted = Number(select.value);
      client.rpc("choose_start", { ride_id: ride.id, start_point: wanted })
        .then(function (res) {
          select.disabled = false;
          if (res.error) {
            showError(refusalText(res.error.message));
            select.value = previous;
            return;
          }
          previous = select.value;
          statusEl.textContent = "Saved: you're starting at " +
            select.options[select.selectedIndex].textContent;
        });
    });
    label.appendChild(select);
    return label;
  }

  // The one thing this member can do about this ride, or a line saying why
  // there is nothing to do. Only a published ride takes sign-ups: a postponed
  // ride may still run, but it cannot be joined, and a member already on it
  // keeps their place and can still cancel it.
  function actionLine(ride, signupStatus, placesTaken, points, chosen) {
    if (ride.status === "cancelled") return null;
    var line = document.createElement("div");
    line.className = "ride-actions";
    if (signupStatus === "confirmed") {
      line.appendChild(textBlock("span", "You're signed up."));
      // A ride that has started takes no change any more: cancel goes, and
      // so does the start choice, which choose_start() would refuse.
      if (isBefore(ride.depart_at)) {
        line.appendChild(document.createTextNode(" "));
        line.appendChild(cancelButton(ride));
        if (points.length > 0) {
          line.appendChild(document.createTextNode(" "));
          line.appendChild(startChoice(ride, points, chosen));
        }
      }
      return line;
    }
    if (ride.status !== "published") return null;
    if (!isBefore(ride.signup_deadline)) {
      line.appendChild(textBlock("span", ride.capacity === null
        ? "Sign-up has closed. You can still join us at the meeting point."
        : "Sign-up has closed."));
      return line;
    }
    if (!currentUser) {
      var signInLink = document.createElement("a");
      signInLink.href = returnToHref();
      signInLink.textContent = "Sign in to sign up";
      line.appendChild(signInLink);
      return line;
    }
    // A count that could not be read is not proof the ride is full:
    // join_ride() counts again under the ride lock, and refuses with a
    // message this page shows.
    if (ride.capacity !== null && placesTaken !== null && placesTaken >= ride.capacity) {
      line.appendChild(textBlock("span", "This ride is full."));
      return line;
    }
    line.appendChild(joinButton(ride, signupStatus));
    return line;
  }

  // ------------------------------------------------------------- rides list

  function appendDetail(item, line) {
    if (line) item.appendChild(line);
  }

  function rideHeading(ride) {
    var heading = document.createElement("div");
    heading.appendChild(textBlock("strong", ride.title));
    if (ride.status === "postponed" || ride.status === "cancelled") {
      heading.appendChild(document.createTextNode(" "));
      heading.appendChild(textBlock("span",
        ride.status === "postponed" ? "Postponed" : "Cancelled", "badge"));
    }
    return heading;
  }

  // Who's riding (#74): signed-in members see each confirmed rider's
  // preferred name, or "A rider" for one who set none. ride_riders() returns
  // names only and refuses a signed-out caller, so a visitor gets an invite
  // to sign in instead. A long list is cut, so the card stays readable.
  var RIDERS_SHOWN = 12;

  function ridersText(names) {
    if (names.length === 0) return "Who's riding: nobody yet. Be the first!";
    var shown = names.slice(0, RIDERS_SHOWN).join(", ");
    var more = names.length - RIDERS_SHOWN;
    return "Who's riding (" + names.length + "): " + shown + (more > 0 ? " and " + more + " more" : "");
  }

  function ridersLine(ride, version) {
    if (ride.status !== "published" && ride.status !== "postponed") return null;
    if (!currentUser) return textBlock("div", "Sign in to see who's riding.", "ride-riders");
    var line = textBlock("div", "Who's riding: ...", "ride-riders");
    client.rpc("ride_riders", { ride_id: ride.id }).then(function (res) {
      // A reply for a list that has been reloaded away is dropped.
      if (version !== listVersion) return;
      if (res.error) {
        line.textContent = "Couldn't read who's riding.";
        return;
      }
      line.textContent = ridersText((res.data || []).map(function (row) {
        return row.display_name;
      }));
    });
    return line;
  }

  function rideItem(ride, signupStatus, version, pointsByRide, choices) {
    var points = pointsByRide[ride.id] || [];
    var chosen = choices[ride.id] || null;
    var item = document.createElement("li");
    // A stable id lets a shared link (rides.html?ride=<id>) find this card.
    item.id = "ride-" + ride.id;
    item.appendChild(rideHeading(ride));
    // One line for the ride's own start point, then each extra point's.
    meetLine(ride, points).forEach(function (line) {
      appendDetail(item, line);
    });
    appendDetail(item, departsLine(ride));
    appendDetail(item, routeLine(ride));
    appendDetail(item, distanceLine(ride));
    appendDetail(item, climbingLine(ride));
    appendDetail(item, textLine("Regroup", ride.regroup_policy));
    appendDetail(item, textLine("Pace", ride.pace_note));
    var closesLine = textBlock("div", "Sign-up closes: " + formatTime(ride.signup_deadline));
    item.appendChild(closesLine);
    appendDetail(item, optionalLine(ride));
    appendDetail(item, ridersLine(ride, version));
    // Sharing does not depend on the places count, so its line is here from
    // the start rather than waiting for the second read below.
    appendDetail(item, shareLine(ride));
    // The places count is a second read, and the action line waits for it:
    // the count chooses between a sign-up button and "This ride is full."
    client.rpc("ride_places_taken", { ride_id: ride.id }).then(function (res) {
      // A reply for a ride that has been reloaded away is dropped.
      if (version !== listVersion) return;
      var taken = null;
      if (res.error) {
        showError("Couldn't read the places taken: " + res.error.message);
      } else {
        taken = Number(res.data || 0);
      }
      if (taken !== null) item.insertBefore(placesLine(ride, taken), closesLine);
      var actions = actionLine(ride, signupStatus, taken, points, chosen);
      if (actions) item.appendChild(actions);
      placesPending -= 1;
      if (placesPending === 0) settleSharedRide();
    });
    return item;
  }

  // A link shared from this page carries the ride in ?ride=<id>. The list is
  // rebuilt on every sign-in and sign-out, so the card is found and scrolled
  // to on the first build only. A past or draft ride is not in this list:
  // then there is nothing to show.
  function showSharedRide() {
    if (sharedRideShown) return;
    sharedRideShown = true;
    var wanted = new URLSearchParams(window.location.search).get("ride");
    if (!wanted) return;
    var item = document.getElementById("ride-" + wanted);
    if (!item) return;
    item.classList.add("ride-highlight");
    item.scrollIntoView({ behavior: "smooth", block: "center" });
    sharedRideItem = item;
  }

  // Every card grows when its places count arrives, which pushes a shared
  // ride further down after the first scroll. Once the last count is in,
  // scroll to it again, and then leave the page where the member puts it.
  function settleSharedRide() {
    if (!sharedRideItem) return;
    if (document.body.contains(sharedRideItem)) {
      sharedRideItem.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    sharedRideItem = null;
  }

  function appendRides(rides, statuses, choices, pointsByRide, version) {
    placesPending = rides.length;
    rides.forEach(function (ride) {
      listEl.appendChild(
        rideItem(ride, statuses[ride.id] || null, version, pointsByRide, choices));
    });
    showSharedRide();
  }

  // The member's own sign-ups, by ride id, and the start point each one
  // chose (null means the ride's own point). RLS limits this read to their
  // own rows: another rider's sign-up cannot come back, whatever is asked
  // for.
  function loadSignupStatuses(rides, pointsByRide, version) {
    var ids = rides.map(function (ride) { return ride.id; });
    client.from("session_signups")
      .select("session_id, status, start_position")
      .in("session_id", ids)
      .then(function (res) {
        if (version !== listVersion) return;
        if (res.error) {
          // The rides themselves still show: a stale guess about a sign-up is
          // corrected by join_ride(), which refuses with a message.
          showError("Couldn't read your sign-ups: " + res.error.message);
        }
        var statuses = {};
        var choices = {};
        (res.data || []).forEach(function (row) {
          statuses[row.session_id] = row.status;
          choices[row.session_id] = row.start_position;
        });
        appendRides(rides, statuses, choices, pointsByRide, version);
      });
  }

  function loadRides() {
    clearError();
    listVersion += 1;
    var version = listVersion;
    clearChildren(listEl);
    emptyEl.hidden = true;
    loadingEl.hidden = false;
    client.from("sessions")
      .select(RIDE_SELECT)
      .in("status", VISIBLE_STATUSES)
      .gte("depart_at", new Date().toISOString())
      .order("meet_at", { ascending: true })
      .then(function (res) {
        if (version !== listVersion) return;
        loadingEl.hidden = true;
        if (res.error) {
          showError("Couldn't load the rides: " + res.error.message);
          return;
        }
        var rides = res.data || [];
        emptyEl.hidden = rides.length > 0;
        if (rides.length === 0) return;
        // The rides' extra start points, by ride id. A failed read costs
        // only those points: point 1 is part of the ride itself, and
        // choose_start() refuses any point it does not know.
        var ids = rides.map(function (ride) { return ride.id; });
        client.from("session_starts")
          .select("session_id, position, place, map_link, start_at")
          .in("session_id", ids)
          .order("position", { ascending: true })
          .then(function (pointsRes) {
            if (version !== listVersion) return;
            var pointsByRide = {};
            if (pointsRes.error) {
              showError("Couldn't read the start points: " +
                pointsRes.error.message);
            } else {
              (pointsRes.data || []).forEach(function (point) {
                if (!pointsByRide[point.session_id]) pointsByRide[point.session_id] = [];
                pointsByRide[point.session_id].push(point);
              });
            }
            // A visitor who is not signed in has no sign-ups to look up.
            if (!currentUser) {
              appendRides(rides, {}, {}, pointsByRide, version);
              return;
            }
            loadSignupStatuses(rides, pointsByRide, version);
          });
      });
  }

  // ---------------------------------------------------------------- wiring

  client.auth.getSession().then(function (res) {
    applySession(res.data.session);
  });
  client.auth.onAuthStateChange(function (event, session) {
    applySession(session);
  });
})();
