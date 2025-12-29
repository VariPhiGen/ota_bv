import React, { useMemo } from "react";
import { Layout, Menu, Button } from "antd";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  CloudUploadOutlined,
  DeploymentUnitOutlined,
  HistoryOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import Devices from "./pages/Devices";
import OTA from "./pages/OTA";
import UploadModel from "./pages/UploadModel";
import UploadConfig from "./pages/UploadConfig";
import Login from "./pages/Login";

const { Header, Content } = Layout;

const menuItems = [
  { key: "/devices", label: "Devices", icon: <DeploymentUnitOutlined /> },
  { key: "/ota", label: "OTA", icon: <HistoryOutlined /> },
  { key: "/upload/model", label: "Upload Model", icon: <CloudUploadOutlined /> },
  { key: "/upload/config", label: "Upload Config", icon: <SettingOutlined /> },
];

const Protected = ({ children }) => {
  const token = localStorage.getItem("basic_token");
  if (!token) return <Navigate to="/login" replace />;
  return children;
};

const App = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const isAuthed = useMemo(() => !!localStorage.getItem("basic_token"), [location]);

  const handleLogout = () => {
    localStorage.removeItem("basic_token");
    navigate("/login");
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center" }}>
        <div style={{ color: "#fff", fontWeight: 600, marginRight: 24 }}>OTA Admin</div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[location.pathname]}
          items={menuItems.map((item) => ({
            key: item.key,
            label: <Link to={item.key}>{item.label}</Link>,
            icon: item.icon,
          }))}
          style={{ flex: 1 }}
        />
        {isAuthed && (
          <Button onClick={handleLogout} style={{ marginLeft: 12 }}>
            Logout
          </Button>
        )}
      </Header>
      <Content style={{ padding: "24px", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <Protected>
                <Devices />
              </Protected>
            }
          />
          <Route
            path="/devices"
            element={
              <Protected>
                <Devices />
              </Protected>
            }
          />
          <Route
            path="/ota"
            element={
              <Protected>
                <OTA />
              </Protected>
            }
          />
          <Route
            path="/upload/model"
            element={
              <Protected>
                <UploadModel />
              </Protected>
            }
          />
          <Route
            path="/upload/config"
            element={
              <Protected>
                <UploadConfig />
              </Protected>
            }
          />
        </Routes>
      </Content>
    </Layout>
  );
};

export default App;
