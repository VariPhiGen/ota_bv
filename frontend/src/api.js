const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const WS_BASE =
  import.meta.env.VITE_WS_URL ||
  (API_BASE.startsWith("https")
    ? API_BASE.replace("https", "wss")
    : API_BASE.replace("http", "ws"));

export const wsUrl = `${WS_BASE}/ws`;

function authHeader() {
  const token = localStorage.getItem("basic_token");
  return token ? { Authorization: `Basic ${token}` } : {};
}

async function http(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...authHeader(), ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const getDevices = () => http("/devices");
export const getDevice = (id) => http(`/devices/${id}`);
export const updateDevice = (payload) =>
  http("/update-device", {
    method: "POST",
    body: JSON.stringify(payload),
  });
export const deleteDevice = ({ sensor_id, device_id }) =>
  http("/delete-device", {
    method: "POST",
    body: JSON.stringify({ sensor_id, device_id }),
  });
export const getOtaHistory = () => http("/ota-history");
export const getOtaStatus = (commandId) => http(`/ota-status/${commandId}`);

export const registerDevice = ({ sensor_id, client_name, device_name }) =>
  http("/devices/register", {
    method: "POST",
    body: JSON.stringify({ sensor_id, client_name, device_name }),
  });

export const registerDeviceSimple = ({ device_id, client_name, sensor_name, sensor_id }) =>
  http("/register-device", {
    method: "POST",
    body: JSON.stringify({ device_id, client_name, sensor_name, sensor_id }),
  });

export const sendOta = (payload) =>
  http("/send-command", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const login = async (username, password) => {
  const token = btoa(`${username}:${password}`);
  const res = await fetch(`${API_BASE}/login`, {
    method: "POST",
    headers: { Authorization: `Basic ${token}` },
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  localStorage.setItem("basic_token", data.basic_token);
  return data;
};

export const uploadModel = async (hefFile, labelsFile, model_name) => {
  const fd = new FormData();
  fd.append("hef_file", hefFile);
  fd.append("labels_file", labelsFile);
  fd.append("model_name", model_name);
  const res = await fetch(`${API_BASE}/upload-model`, {
    method: "POST",
    headers: { ...authHeader() },
    body: fd,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
};

export const uploadConfig = async (configFile, updatesJson, config_name) => {
  const fd = new FormData();
  fd.append("config_file", configFile);
  fd.append("config_name", config_name);
  if (updatesJson) {
    fd.append("updates", updatesJson);
  }
  const res = await fetch(`${API_BASE}/upload-config`, {
    method: "POST",
    headers: { ...authHeader() },
    body: fd,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
};

export const listUploads = () => http("/list-uploads");
export const deleteUpload = (key) =>
  http("/delete-upload", {
    method: "POST",
    body: JSON.stringify({ key }),
  });

export const deleteModel = (model_name) =>
  http("/delete-model", {
    method: "POST",
    body: JSON.stringify({ model_name }),
  });

export const deleteConfig = (config_name) =>
  http("/delete-config", {
    method: "POST",
    body: JSON.stringify({ config_name }),
  });
