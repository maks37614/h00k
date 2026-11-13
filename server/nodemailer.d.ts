declare module 'nodemailer' {
  interface Transport {
    sendMail(options: {
      from: string;
      to: string;
      subject: string;
      text: string;
    }): Promise<unknown>;
  }
  const nodemailer: {
    createTransport(options: {
      host?: string;
      port?: number;
      secure?: boolean;
      requireTLS?: boolean;
      tls?: { minVersion: string };
      auth?: { user: string; pass: string };
      pool?: boolean;
      maxConnections?: number;
      maxMessages?: number;
    }): Transport;
  };
  export default nodemailer;
}
