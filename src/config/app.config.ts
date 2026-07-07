export const appConfig = {
  port: Number(process.env.PORT ?? 3000),
  isTest: process.env.NODE_ENV === 'test',
};
