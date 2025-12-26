import ObsClientSdk from 'esdk-obs-nodejs';

const ObsClient = ObsClientSdk?.default || ObsClientSdk;
const OBS_AK = 'HPUAVAKVYRUUYKOIUUYZ';
const OBS_SK = 'Kax2vXaUmYbMXyMxFqEk7LDjVCnJQHSOL1wOLVrQ';
const OBS_ENDPOINT = 'https://obs.cn-south-1.myhuaweicloud.com';
const OBS_BUCKET_NAME = 'light-note-files';
if (!OBS_AK || !OBS_SK || !OBS_ENDPOINT || !OBS_BUCKET_NAME) {
  console.warn('[OBS] Missing OBS env config, signed URL generation will fail until configured.');
}

const obsClient = new ObsClient({
  access_key_id: OBS_AK,
  secret_access_key: OBS_SK,
  server: OBS_ENDPOINT,
});

const bucketName = OBS_BUCKET_NAME;
const normalizeBaseUrl = () => {
  const endpointHost = (OBS_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${bucketName}.${endpointHost}`;
};

export const bucketBaseUrl = normalizeBaseUrl();

export const buildObjectKey = (userId, fileName) => `files/${userId}/${fileName}`;

export const createUploadSignedUrl = ({ objectKey, contentType, expires = 900 }) => {
  const fallbackContentType = contentType || 'application/octet-stream';
  const { SignedUrl, ActualSignedRequestHeaders } = obsClient.createSignedUrlSync({
    Method: 'PUT',
    Bucket: bucketName,
    Key: objectKey,
    Expires: expires,
    Headers: {
      'Content-Type': fallbackContentType,
    },
  });

  return {
    url: SignedUrl,
    headers: ActualSignedRequestHeaders || { 'Content-Type': fallbackContentType },
    expiresIn: expires,
  };
};

export const createDownloadSignedUrl = ({ objectKey, expires = 900 }) => {
  const { SignedUrl } = obsClient.createSignedUrlSync({
    Method: 'GET',
    Bucket: bucketName,
    Key: objectKey,
    Expires: expires,
  });

  return { url: SignedUrl, expiresIn: expires };
};

const wrapObsCall = (fn, params) =>
  new Promise((resolve, reject) => {
    fn(params, (err, result) => {
      if (err) {
        return reject(err);
      }
      if (result?.CommonMsg?.Status && result.CommonMsg.Status >= 300) {
        const message = result.CommonMsg.Message || result.CommonMsg.Code || `OBS error ${result.CommonMsg.Status}`;
        return reject(new Error(message));
      }
      resolve(result);
    });
  });

export const deleteObjectFromObs = async (objectKey) =>
  wrapObsCall(obsClient.deleteObject.bind(obsClient), { Bucket: bucketName, Key: objectKey });

export const copyObjectInObs = async (sourceKey, targetKey) =>
  wrapObsCall(obsClient.copyObject.bind(obsClient), {
    Bucket: bucketName,
    Key: targetKey,
    CopySource: `${bucketName}/${sourceKey}`,
  });

export const buildObjectUrl = (objectKey) => `${bucketBaseUrl}/${objectKey}`;

export default obsClient;
