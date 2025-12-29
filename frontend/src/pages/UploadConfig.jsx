import React, { useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, Upload, List, Popconfirm, message, Table } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import { uploadConfig, listUploads, deleteConfig } from "../api";

const UploadConfig = () => {
  const [configFile, setConfigFile] = useState(null);
  const [configName, setConfigName] = useState("");
  const [updates, setUpdates] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploads, setUploads] = useState([]);

  const loadUploads = async () => {
    try {
      const data = await listUploads();
      setUploads(data.configs || []);
    } catch (err) {
      // ignore
    }
  };

  useEffect(() => {
    loadUploads();
  }, []);

  const beforeUploadConfig = (file) => {
    if (!file.name.toLowerCase().endsWith(".json")) {
      setError("Config file must be .json");
      return Upload.LIST_IGNORE;
    }
    setConfigFile(file);
    setError("");
    return false;
  };

  const onSubmit = async () => {
    if (!configName.trim()) {
      setError("Config name required");
      return;
    }
    if (!configFile) {
      setError("Config JSON required");
      return;
    }
    try {
      setLoading(true);
      setResult(await uploadConfig(configFile, "", configName.trim()));
      await loadUploads();
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const onDelete = async (name) => {
    try {
      await deleteConfig(name);
      message.success("Deleted");
      await loadUploads();
    } catch (err) {
      message.error(err.message);
    }
  };

  const columns = [
    { title: "Path", dataIndex: "path" },
    { title: "Value", dataIndex: "value", render: (v) => JSON.stringify(v) },
  ];

  return (
    <Card title="Upload Config">
      <Form layout="vertical" onFinish={onSubmit}>
        <Form.Item label="Config name" required>
          <Input placeholder="e.g. factory_camera_config_v2" value={configName} onChange={(e) => setConfigName(e.target.value)} />
        </Form.Item>
        <Form.Item label="Config JSON" required>
          <Upload beforeUpload={beforeUploadConfig} maxCount={1} fileList={configFile ? [configFile] : []}>
            <Button icon={<UploadOutlined />}>Select config.json</Button>
          </Upload>
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            Upload
          </Button>
        </Form.Item>
      </Form>
      <Table
        size="small"
        pagination={false}
        dataSource={updates.map((u, idx) => ({ key: idx, ...u }))}
        columns={columns}
        style={{ marginBottom: 12 }}
      />
      {error && <Alert type="error" message={error} />}
      {result && (
        <Alert
          type="success"
          message="Config uploaded"
          description={
            <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre>
          }
          showIcon
        />
      )}
      <Card title="Uploaded configs" size="small" style={{ marginTop: 16 }}>
        <List
          dataSource={uploads}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Popconfirm key="del" title="Delete config?" onConfirm={() => onDelete(item.name)}>
                  <Button size="small" danger>
                    Delete
                  </Button>
                </Popconfirm>,
              ]}
            >
              {item.name || item.file || item.key}{" "}
              {item.file_url && <span style={{ color: "#888" }}>({item.file_url})</span>}
            </List.Item>
          )}
        />
      </Card>
    </Card>
  );
};

export default UploadConfig;
