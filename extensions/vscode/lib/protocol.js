'use strict';

const SUPPORTED_PROTOCOL_MAJOR = 1;

function validateServiceInfo(value) {
  if (!value || typeof value !== 'object' || typeof value.protocol_version !== 'string' || typeof value.service_version !== 'string' || !Array.isArray(value.capabilities)) {
    throw new Error('本机服务缺少协议字段，请升级或重新安装 Porthole。');
  }
  const major = Number(value.protocol_version.split('.')[0]);
  if (!Number.isInteger(major) || major !== SUPPORTED_PROTOCOL_MAJOR) {
    throw new Error(`VERSION_INCOMPATIBLE：扩展支持协议主版本 ${SUPPORTED_PROTOCOL_MAJOR}，服务返回 ${value.protocol_version}。`);
  }
  return value;
}

module.exports = { SUPPORTED_PROTOCOL_MAJOR, validateServiceInfo };
