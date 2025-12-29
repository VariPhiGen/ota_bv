import React, { useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, Upload, List, Popconfirm, message } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import { uploadModel, listUploads, deleteModel } from "../api";

const UploadModel = () => {
  const [hefFile, setHefFile] = useState(null);
  const [labelsFile, setLabelsFile] = useState(null);
  const [modelName, setModelName] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploads, setUploads] = useState([]);

  const loadUploads = async () => {
    try {
      const data = await listUploads();
      setUploads(data.models || []);
    } catch (err) {
      // ignore listing errors
    }
  };

  useEffect(() => {
    loadUploads();
  }, []);

  const beforeUpload = (setter, acceptExt) => (file) => {
    if (!file.name.toLowerCase().endsWith(acceptExt)) {
      setError(`File must end with ${acceptExt}`);
      return Upload.LIST_IGNORE;
    }
    setter(file);
    setError("");
    return false;
  };

  const onSubmit = async () => {
    if (!modelName.trim()) {
      setError("Model name is required");
      return;
    }
    if (!hefFile || !labelsFile) {
      setError("Both .hef and labels.json are required");
      return;
    }
    try {
      setLoading(true);
      setResult(await uploadModel(hefFile, labelsFile, modelName.trim()));
      await loadUploads();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const onDelete = async (name) => {
    try {
      await deleteModel(name);
      message.success("Deleted");
      await loadUploads();
    } catch (err) {
      message.error(err.message);
    }
  };

  return (
    <Card title="Upload Model">
      <Form layout="vertical" onFinish={onSubmit}>
        <Form.Item label="Model name" required>
          <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="e.g. ppe_yolo_v5_v3" />
        </Form.Item>
        <Form.Item label=".hef file" required>
          <Upload beforeUpload={beforeUpload(setHefFile, ".hef")} maxCount={1} fileList={hefFile ? [hefFile] : []}>
            <Button icon={<UploadOutlined />}>Select .hef</Button>
          </Upload>
        </Form.Item>
        <Form.Item label="labels.json" required>
          <Upload
            beforeUpload={beforeUpload(setLabelsFile, ".json")}
            maxCount={1}
            fileList={labelsFile ? [labelsFile] : []}
          >
            <Button icon={<UploadOutlined />}>Select labels.json</Button>
          </Upload>
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            Upload
          </Button>
        </Form.Item>
      </Form>
      {error && <Alert type="error" message={error} style={{ marginTop: 12 }} />}
      {result && <Alert type="success" message="Uploaded" description={JSON.stringify(result, null, 2)} showIcon />}
      <Card title="Uploaded models" size="small" style={{ marginTop: 16 }}>
        <List
          dataSource={uploads}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Popconfirm key="del" title="Delete model?" onConfirm={() => onDelete(item.name)}>
                  <Button size="small" danger>
                    Delete
                  </Button>
                </Popconfirm>,
              ]}
            >
              {item.name || item.files?.model || item.key}{" "}
              {item.files?.model_url && <span style={{ color: "#888" }}>({item.files.model_url})</span>}
            </List.Item>
          )}
        />
      </Card>
    </Card>
  );
};

export default UploadModel;
