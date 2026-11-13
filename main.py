import decky_plugin
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile

from settings import SettingsManager # type: ignore

logger = decky_plugin.logger

settings = SettingsManager(name="settings", settings_directory=decky_plugin.DECKY_PLUGIN_SETTINGS_DIR)
settings.read()

counter = SettingsManager(name="counter", settings_directory=decky_plugin.DECKY_PLUGIN_RUNTIME_DIR)
counter.read()

class Plugin:
  def _queue_path(self, account):
    if not isinstance(account, str) or not re.fullmatch(r"[0-9]{17}", account):
      raise ValueError("Invalid Steam account ID")
    directory = Path(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR) / "upload-queue-v1"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    return directory / f"{account}.json"

  def _validate_queue(self, state):
    if not isinstance(state, dict):
      raise ValueError("Invalid queue")
    self._queue_path(state.get("account"))
    if type(state.get("version")) is not int or state["version"] != 1:
      raise ValueError("Unsupported queue version")
    if type(state.get("revision")) is not int or state["revision"] < 0:
      raise ValueError("Invalid queue revision")
    tasks = state.get("tasks")
    if not isinstance(tasks, list) or len(tasks) > 50000:
      raise ValueError("Invalid queue tasks")
    seen = set()
    for task in tasks:
      if not isinstance(task, dict):
        raise ValueError("Invalid task")
      game = task.get("gameId")
      path = task.get("path")
      if not isinstance(game, str) or not re.fullmatch(r"[0-9]{1,20}", game):
        raise ValueError("Invalid game ID")
      if (not isinstance(path, str) or len(path) > 2048 or not path.startswith("screenshots/")
          or ".." in path.split("/") or "\\" in path):
        raise ValueError("Invalid screenshot path")
      for key in ("created", "attempts", "nextAttemptAt", "updatedAt"):
        if type(task.get(key)) is not int or not 0 <= task[key] <= 9007199254740991:
          raise ValueError(f"Invalid task {key}")
      if task["attempts"] > 5:
        raise ValueError("Invalid attempt count")
      if type(task.get("privacy")) is not int or task["privacy"] not in (2, 4, 8, 16):
        raise ValueError("Invalid privacy")
      if task.get("status") not in ("pending", "uploading", "waiting", "verifying", "failed"):
        raise ValueError("Invalid task status")
      if not isinstance(task.get("error"), str) or len(task["error"]) > 500:
        raise ValueError("Invalid task error")
      identity = task.get("id")
      if not isinstance(identity, str) or len(identity) > 4096:
        raise ValueError("Invalid task identity")
      if json.loads(identity) != [state["account"], game, path, task["created"]]:
        raise ValueError("Task belongs to a different account or screenshot")
      if identity in seen:
        raise ValueError("Duplicate task")
      seen.add(identity)

  def _read_queue(self, account):
    path = self._queue_path(account)
    if not path.exists():
      return {"version": 1, "account": account, "revision": 0, "tasks": []}
    # Corrupt or unsupported state is surfaced, never silently replaced.
    with path.open(encoding="utf-8") as file:
      state = json.load(file)
    self._validate_queue(state)
    if state["account"] != account:
      raise ValueError("Queue account mismatch")
    return state

  async def loadQueue(self, account: str):
    return self._read_queue(account)

  async def saveQueue(self, state):
    self._validate_queue(state)
    path = self._queue_path(state["account"])
    # File locking + revision check also protect against overlapping plugin reloads.
    lock_fd = os.open(path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock_fd, "a") as lock:
      fcntl.flock(lock, fcntl.LOCK_EX)
      previous = self._read_queue(state["account"])
      if state["revision"] != previous["revision"]:
        raise ValueError("Queue changed in another instance; reload required")
      saved = {**state, "revision": state["revision"] + 1}
      temporary = None
      try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.stem + ".", suffix=".tmp", delete=False) as file:
          temporary = file.name
          json.dump(saved, file, ensure_ascii=False, separators=(",", ":"))
          file.flush()
          os.fsync(file.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
          os.fsync(directory_fd)
        finally:
          os.close(directory_fd)
      finally:
        if temporary and os.path.exists(temporary):
          os.unlink(temporary)
      return saved["revision"]

  async def plugin_info(self):
    # Call plugin_info only once preferably
    logger.debug('[backend] PluginInfo:\n\tPluginName: {}\n\tPluginVersion: {}\n\tDeckyVersion: {}'.format(
      decky_plugin.DECKY_PLUGIN_NAME,
      decky_plugin.DECKY_PLUGIN_VERSION,
      decky_plugin.DECKY_VERSION
    ))
    pluginInfo = {
      "name": decky_plugin.DECKY_PLUGIN_NAME,
      "version": decky_plugin.DECKY_PLUGIN_VERSION
    }
    return pluginInfo
  async def logger(self, logLevel:str, msg:str):
    msg = '[frontend] {}'.format(msg)
    match logLevel.lower():
      case 'info':      logger.info(msg)
      case 'debug':     logger.debug(msg)
      case 'warning':   logger.warning(msg)
      case 'error':     logger.error(msg)
      case 'critical':  logger.critical(msg)
  async def getSetting(self, key: str, defaults):
    logger.info('[backend] Reading setting {}'.format(key))
    return settings.getSetting(key, defaults)
  async def putSetting(self, key: str, value):
    logger.info('[backend] Setting setting {}: {}'.format(key, value))
    return settings.setSetting(key, value)
  async def increaseCounter(self, key: str):
    return counter.setSetting(key, counter.getSetting(key, 0) + 1)
  async def getCounter(self, key: str):
    return counter.getSetting(key, 0)
  async def _unload(self):
    pass
