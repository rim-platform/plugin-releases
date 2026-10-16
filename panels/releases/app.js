// The Releases panel. The plugin frame sends its state through the host
// (panel.state_update); the panel runs the plugin's commands through the host
// bridge (rim.command.execute). It renders everything as text and has no links,
// since following one would navigate the panel's frame, which closes it. While
// it is open it asks the plugin to refresh once the list is 10 minutes old.
(function () {
  "use strict";

  var PLUGIN_ID = "chat.rim.releases";
  var AUTO_REFRESH_MS = 10 * 60 * 1000;
  var AUTO_CHECK_MS = 60 * 1000;
  var state = null;
  var nextRequest = 1;
  var pending = {};
  var lastAutoRefresh = 0;

  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    repo: $("repo"),
    add: $("add"),
    refresh: $("refresh"),
    notice: $("notice"),
    list: $("list"),
    empty: $("empty"),
    refreshed: $("refreshed"),
  };

  function send(message) {
    window.parent.postMessage(message, "*");
  }

  /** Run one of this plugin's commands; `onResult` gets the host's answer. */
  function run(verb, args, onResult) {
    var requestId = "releases-" + nextRequest++;
    if (onResult) pending[requestId] = onResult;
    send({
      type: "rim.command.execute",
      commandId: "plugin." + PLUGIN_ID + "." + verb,
      args: args || {},
      requestId: requestId,
    });
  }

  function showNotice(text) {
    els.notice.hidden = !text;
    els.notice.textContent = text || "";
  }

  function day(iso) {
    return typeof iso === "string" ? iso.slice(0, 10) : "";
  }

  function clock(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    return (
      String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0")
    );
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** The version, its pre-release badge and its date, in `node`. */
  function fillRelease(node, release) {
    node.appendChild(element("span", "version", release.version));
    if (release.prerelease) node.appendChild(element("span", "badge", "pre-release"));
    var date = day(release.publishedAt);
    if (date) node.appendChild(element("span", "meta", " · " + date));
    node.title = release.url;
    return node;
  }

  function renderRepo(repo) {
    var section = element("section");
    var heading = element("h2");
    heading.appendChild(element("span", "name", repo.repo));
    var remove = element("button", "", "×");
    remove.type = "button";
    remove.title = "Remove " + repo.repo;
    remove.setAttribute("aria-label", "Remove " + repo.repo);
    remove.addEventListener("click", function () {
      run("remove_repo", { repo: repo.repo }, report);
    });
    heading.appendChild(remove);
    section.appendChild(heading);
    if (repo.error) section.appendChild(element("div", "error", repo.error));
    var latest = repo.releases[0];
    if (!latest) {
      if (!repo.error) section.appendChild(element("div", "none", "No published release yet."));
      return section;
    }
    var top = element("div", "latest");
    top.appendChild(fillRelease(element("div"), latest));
    var named = latest.name && latest.name !== latest.tag && latest.name !== latest.version;
    var summary = named ? latest.name : latest.firstLine;
    if (summary) top.appendChild(element("div", "summary", summary));
    section.appendChild(top);
    var earlier = repo.releases.slice(1);
    if (earlier.length > 0) {
      var details = element("details");
      details.appendChild(
        element(
          "summary",
          "",
          earlier.length + " earlier release" + (earlier.length === 1 ? "" : "s"),
        ),
      );
      var list = element("ul");
      earlier.forEach(function (release) {
        list.appendChild(fillRelease(element("li"), release));
      });
      details.appendChild(list);
      section.appendChild(details);
    }
    return section;
  }

  function render() {
    els.list.textContent = "";
    if (!state) return;
    var full = state.repos.length >= state.maxRepos;
    els.repo.disabled = !state.signedIn || full;
    els.add.disabled = !state.signedIn || full;
    els.refresh.disabled = state.loading;
    els.refresh.textContent = state.loading ? "Loading…" : "Refresh";
    showNotice(state.notice);
    state.repos.forEach(function (repo) {
      els.list.appendChild(renderRepo(repo));
    });
    els.empty.hidden = state.repos.length > 0;
    els.empty.textContent = state.signedIn
      ? "Add a public repository as owner/name to see its latest releases."
      : "Sign in to keep a list of repositories.";
    els.refreshed.textContent = state.fetchedAt ? "Refreshed at " + clock(state.fetchedAt) : "";
  }

  /** Show a failed command's message; a successful one shows in the state. */
  function report(result) {
    if (result && !result.ok && !result.cancelled) showNotice(result.message);
  }

  /** Refresh once the list, or the last automatic try, is 10 minutes old. */
  function autoRefresh() {
    if (!state || !state.signedIn || state.loading || state.repos.length === 0) return;
    var since = Math.max(Date.parse(state.fetchedAt) || 0, lastAutoRefresh);
    if (Date.now() - since < AUTO_REFRESH_MS) return;
    lastAutoRefresh = Date.now();
    run("refresh", {}, report);
  }

  function addRepo() {
    var repo = els.repo.value.trim();
    if (!repo) return;
    run("add_repo", { repo: repo }, function (result) {
      if (result.ok) els.repo.value = "";
      report(result);
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || typeof message.type !== "string") return;
    switch (message.type) {
      case "theme.changed":
        Object.keys(message.variables || {}).forEach(function (name) {
          var value = message.variables[name];
          if (value) document.documentElement.style.setProperty(name, value);
        });
        break;
      case "panel.state_update":
        state = message.state;
        if (state === null) {
          els.empty.hidden = false;
          els.empty.textContent = "The plugin stopped.";
          els.list.textContent = "";
          els.refreshed.textContent = "";
          return;
        }
        render();
        autoRefresh();
        break;
      case "rim.command.result": {
        var done = pending[message.requestId];
        delete pending[message.requestId];
        if (done) done(message);
        break;
      }
    }
  });

  els.add.addEventListener("click", addRepo);
  els.repo.addEventListener("keydown", function (event) {
    if (event.key === "Enter") addRepo();
  });
  els.refresh.addEventListener("click", function () {
    run("refresh", {}, report);
  });
  document.addEventListener("keydown", function (event) {
    if (event.target === els.repo) return;
    if (event.key === "r") run("refresh", {}, report);
    if (event.key === "/") {
      event.preventDefault();
      els.repo.focus();
    }
  });
  setInterval(autoRefresh, AUTO_CHECK_MS);
})();
