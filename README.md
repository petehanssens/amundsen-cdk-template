# Amundsen CDK Template

![Amundsen Architecture](/images/amundsen-architecture.png)


## Basic Architecture

Amundsen is hosted on fargate with 3 containers:

- frontend service on port 5000
- search service on port 5001
- metadata service on port 5002

There are also two AWS managed services used to store state:

- Amazon Neptune
- Amazon Elasticsearch Service

## Getting Started

The configuration of this project is handled by projen - created by the makers of CDK in order to help with repo setup. You'll need to take a look at the .projenrc.js file to check all of the variables and update according to your preference. Once that's done, you'll need to run the following to install node modules etc:

```
npx projen
```

Once you've done that, it's time to run a build.

```
yarn build
```

Once that's successful, you can go ahead and deploy the stacks:

```
yarn deploy-all
```

## Things to fix / add in

Current the ALB and Route 53 implementation needs to be fixed as it's not working correctly just yet. However you can still address the service using the IP address from the Fargate console along with the port of the container you are trying to address.
