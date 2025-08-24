pipeline {
  agent any
  options { timestamps(); ansiColor('xterm') }

  parameters {
    string(name: 'IMAGE_NAME',     defaultValue: 'portfolio-site',     description: 'Docker image name')
    string(name: 'IMAGE_TAG',      defaultValue: 'build-${BUILD_NUMBER}', description: 'Docker image tag')
    string(name: 'APP_PORT',       defaultValue: '8081',               description: 'Host port')
    string(name: 'CONTAINER_PORT',       defaultValue: '80',               description: 'Container port')
    string(name: 'CONTAINER_NAME', defaultValue: 'portfolio_site',     description: 'Container name')
  }

  environment {
    DOCKER_IMAGE = "${params.IMAGE_NAME}:${params.IMAGE_TAG}"
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Docker Build') {
      steps {
        sh """
          docker version
          docker build -t ${DOCKER_IMAGE} .
          docker image ls | grep ${params.IMAGE_NAME}
        """
      }
    }

    stage('Deploy') {
      steps {
        sh """
          # Remove old version container
          docker rm -f ${params.CONTAINER_NAME} 2>/dev/null || true

          # Run new version container
          docker run -d --name ${params.CONTAINER_NAME} \
            -p ${params.APP_PORT}:${params.CONTAINER_PORT} \
            --restart unless-stopped \
            ${DOCKER_IMAGE}
        """
      }
    }

    stage('Info') {
      steps {
        script {
          echo "Deployed!"
        }
      }
    }
  }
}
