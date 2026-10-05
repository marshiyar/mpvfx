// Library ownership and catalog mutations live here, independent of Electron.
// All SQLite IO executes on Node's worker pool, never the UI/main thread.
#define NAPI_VERSION 8
#include <node_api.h>
#include <sqlite3.h>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#endif
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
struct Database {
  sqlite3* db = nullptr;
  Database(const std::string& path, bool create) {
    const int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | (create ? SQLITE_OPEN_CREATE : 0);
    if (sqlite3_open_v2(path.c_str(), &db, flags, nullptr) != SQLITE_OK) {
      std::string error = db ? sqlite3_errmsg(db) : "Cannot open catalog";
      if (db) sqlite3_close(db);
      db = nullptr;
      throw std::runtime_error(error);
    }
    sqlite3_busy_timeout(db, 5000);
  }
  ~Database() { if (db) sqlite3_close(db); }
  void exec(const char* sql) {
    char* error = nullptr;
    if (sqlite3_exec(db, sql, nullptr, nullptr, &error) != SQLITE_OK) {
      std::string message = error ? error : sqlite3_errmsg(db);
      sqlite3_free(error);
      throw std::runtime_error(message);
    }
  }
  std::string query(const char* sql, const std::vector<std::string>& values = {}) {
    sqlite3_stmt* raw = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &raw, nullptr) != SQLITE_OK) throw std::runtime_error(sqlite3_errmsg(db));
    std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> stmt(raw, sqlite3_finalize);
    if (sqlite3_bind_parameter_count(raw) != static_cast<int>(values.size())) throw std::runtime_error("Invalid command arguments");
    for (size_t i = 0; i < values.size(); ++i) {
      if (sqlite3_bind_text(raw, static_cast<int>(i + 1), values[i].data(), static_cast<int>(values[i].size()), SQLITE_TRANSIENT) != SQLITE_OK)
        throw std::runtime_error(sqlite3_errmsg(db));
    }
    int result = sqlite3_step(raw);
    if (result == SQLITE_ROW) {
      auto text = sqlite3_column_text(raw, 0);
      return text ? reinterpret_cast<const char*>(text) : "null";
    }
    if (result != SQLITE_DONE) throw std::runtime_error(sqlite3_errmsg(db));
    return "null";
  }
};
const char* schema = R"SQL(
CREATE TABLE library(id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL CHECK(version=1));
CREATE TABLE events(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE projects(id TEXT PRIMARY KEY, eventId TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready')));
CREATE TABLE assets(id TEXT PRIMARY KEY, eventId TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('managed','linked')), source TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready')));
CREATE TABLE placements(projectId TEXT NOT NULL REFERENCES projects(id), assetId TEXT NOT NULL REFERENCES assets(id), path TEXT NOT NULL, PRIMARY KEY(projectId,assetId), UNIQUE(projectId,path));
CREATE TABLE jobs(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), snapshot TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '');
PRAGMA user_version=1;
)SQL";
const char* snapshot = R"SQL(
SELECT json_object(
 'id',(SELECT id FROM library), 'name',(SELECT name FROM library),
 'events',json((SELECT json_group_array(json_object('id',id,'name',name)) FROM events)),
 'projects',json((SELECT json_group_array(json_object('id',id,'eventId',eventId,'name',name,'state',state)) FROM projects)),
 'assets',json((SELECT json_group_array(json_object('id',id,'eventId',eventId,'name',name,'kind',kind,'mode',mode,'source',source,'fingerprint',fingerprint,'state',state)) FROM assets)),
 'placements',json((SELECT json_group_array(json_object('projectId',projectId,'assetId',assetId,'path',path)) FROM placements)),
 'jobs',json((SELECT json_group_array(json_object('id',id,'projectId',projectId,'snapshot',snapshot,'status',status,'output',output,'error',error)) FROM jobs))
)
)SQL";
std::string command(const std::string& path, const std::string& action, const std::vector<std::string>& args) {
  Database d(path, action == "create");
  d.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
  if (action == "create") {
    d.exec("BEGIN IMMEDIATE;");
    d.exec(schema);
    d.query("INSERT INTO library VALUES(?1,?2,1)", args);
    d.exec("COMMIT;");
  } else {
    if (d.query("PRAGMA user_version") != "1") throw std::runtime_error("Unsupported library catalog version");
    d.exec("BEGIN IMMEDIATE;");
    if (action == "event") d.query("INSERT INTO events VALUES(?1,?2)", args);
    else if (action == "project") d.query("INSERT INTO projects VALUES(?1,?2,?3,'pending')", args);
    else if (action == "projectReady") d.query("UPDATE projects SET state='ready' WHERE id=?1", args);
    else if (action == "asset") d.query("INSERT INTO assets VALUES(?1,?2,?3,?4,?5,?6,?7,'pending')", args);
    else if (action == "assetReady") d.query("UPDATE assets SET state='ready' WHERE id=?1", args);
    else if (action == "relink") d.query("UPDATE assets SET source=?2 WHERE id=?1 AND mode='linked'", args);
    else if (action == "attach") d.query("INSERT INTO placements VALUES(?1,?2,?3) ON CONFLICT(projectId,assetId) DO UPDATE SET path=excluded.path", args);
    else if (action == "job") d.query("INSERT INTO jobs(id,projectId,snapshot,status) VALUES(?1,?2,?3,'rendering')", args);
    else if (action == "jobFinish") d.query("UPDATE jobs SET status=?2,output=?3,error=?4 WHERE id=?1", args);
    else if (action == "recover") d.exec("UPDATE jobs SET status='interrupted',error='Application closed before export completion; export again from the saved snapshot' WHERE status='rendering';");
    else if (action != "read") throw std::runtime_error("Unknown library command");
    else if (!args.empty()) throw std::runtime_error("Invalid read arguments");
    d.exec("COMMIT;");
  }
  return d.query(snapshot);
}
struct Work {
  napi_async_work work{};
  napi_deferred deferred{};
  std::string path, action, result, error;
  std::vector<std::string> args;
};
void check(napi_status status) { if (status != napi_ok) throw std::runtime_error("Invalid native library argument"); }
std::string string(napi_env env, napi_value value) {
  size_t size;
  check(napi_get_value_string_utf8(env, value, nullptr, 0, &size));
  std::vector<char> buffer(size + 1);
  check(napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &size));
  std::string result(buffer.data(), size);
  if (result.find('\0') != std::string::npos) throw std::runtime_error("Embedded NUL is not permitted");
  return result;
}
napi_value run(napi_env env, napi_callback_info info) {
  try {
    size_t count = 3; napi_value argv[3];
    check(napi_get_cb_info(env, info, &count, argv, nullptr, nullptr));
    if (count != 3) throw std::runtime_error("Expected catalog path, command, arguments");
    auto w = std::make_unique<Work>();
    w->path = string(env, argv[0]); w->action = string(env, argv[1]);
    uint32_t length; check(napi_get_array_length(env, argv[2], &length));
    if (length > 16) throw std::runtime_error("Too many arguments");
    for (uint32_t i=0;i<length;++i) { napi_value v; check(napi_get_element(env,argv[2],i,&v)); w->args.push_back(string(env,v)); }
    napi_value promise, name;
    check(napi_create_string_utf8(env,"library-catalog",NAPI_AUTO_LENGTH,&name));
    check(napi_create_promise(env,&w->deferred,&promise));
    check(napi_create_async_work(env,nullptr,name,[](napi_env,void* data) {
      auto* w=static_cast<Work*>(data);
      try { w->result=command(w->path,w->action,w->args); }
      catch(const std::exception& e) { w->error=e.what(); }
    },[](napi_env env,napi_status status,void* data) {
      std::unique_ptr<Work> w(static_cast<Work*>(data)); napi_value value;
      if(status!=napi_ok && w->error.empty()) w->error="Library command cancelled";
      if(w->error.empty()) {
        napi_create_string_utf8(env,w->result.c_str(),w->result.size(),&value);
        napi_resolve_deferred(env,w->deferred,value);
      } else {
        napi_value message; napi_create_string_utf8(env,w->error.c_str(),w->error.size(),&message);
        napi_create_error(env,nullptr,message,&value); napi_reject_deferred(env,w->deferred,value);
      }
      napi_delete_async_work(env,w->work);
    },w.get(),&w->work));
    check(napi_queue_async_work(env,w->work)); w.release(); return promise;
  } catch(const std::exception& e) { napi_throw_error(env,"library-command-failed",e.what()); return nullptr; }
}
struct Lock {
#ifdef _WIN32
  HANDLE handle = INVALID_HANDLE_VALUE;
  void close() { if (handle != INVALID_HANDLE_VALUE) { CloseHandle(handle); handle = INVALID_HANDLE_VALUE; } }
#else
  int fd = -1;
  void close() { if (fd >= 0) { ::close(fd); fd = -1; } }
#endif
  ~Lock() { close(); }
};
#ifdef _WIN32
std::wstring widePath(const std::string& path) {
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), static_cast<int>(path.size()), nullptr, 0);
  if (size <= 0) throw std::runtime_error("Invalid UTF-8 library lock path");
  std::wstring result(static_cast<size_t>(size), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), static_cast<int>(path.size()), result.data(), size) != size)
    throw std::runtime_error("Invalid UTF-8 library lock path");
  return result;
}
#endif
napi_value lockLibrary(napi_env env, napi_callback_info info) {
  try {
    size_t count=1; napi_value arg;
    check(napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr));
    const auto path=string(env,arg);
    auto lock=std::make_unique<Lock>();
#ifdef _WIN32
    // No sharing permits exactly one process to own the catalog. Open the
    // reparse point itself and reject it, matching O_NOFOLLOW on Unix.
    const auto wide=widePath(path);
    lock->handle=CreateFileW(wide.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    BY_HANDLE_FILE_INFORMATION fileInfo{};
    if(lock->handle==INVALID_HANDLE_VALUE || !GetFileInformationByHandle(lock->handle,&fileInfo) ||
       (fileInfo.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))!=0)
      throw std::runtime_error("Library is already open in another process or is not writable");
#else
    lock->fd=::open(path.c_str(),O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,0600);
    if(lock->fd<0 || flock(lock->fd,LOCK_EX|LOCK_NB)!=0) throw std::runtime_error("Library is already open in another process or is not writable");
#endif
    napi_value result;
    check(napi_create_external(env,lock.get(),[](napi_env,void* data,void*) { delete static_cast<Lock*>(data); },nullptr,&result));
    lock.release(); return result;
  } catch(const std::exception& e) { napi_throw_error(env,"library-locked",e.what()); return nullptr; }
}
napi_value unlockLibrary(napi_env env,napi_callback_info info) {
  size_t count=1; napi_value arg; void* ptr=nullptr;
  if(napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr)!=napi_ok || napi_get_value_external(env,arg,&ptr)!=napi_ok) {
    napi_throw_error(env,"invalid-lock","Invalid library lock"); return nullptr;
  }
  auto* lock=static_cast<Lock*>(ptr);
  lock->close();
  napi_value result; napi_get_undefined(env,&result); return result;
}
napi_value init(napi_env env,napi_value exports) {
  napi_value fn; napi_create_function(env,"command",NAPI_AUTO_LENGTH,run,nullptr,&fn);
  napi_set_named_property(env,exports,"command",fn);
  napi_create_function(env,"lock",NAPI_AUTO_LENGTH,lockLibrary,nullptr,&fn); napi_set_named_property(env,exports,"lock",fn);
  napi_create_function(env,"unlock",NAPI_AUTO_LENGTH,unlockLibrary,nullptr,&fn); napi_set_named_property(env,exports,"unlock",fn);
  return exports;
}
}
NAPI_MODULE(mpvfx_library, init)
